import {
  AuthType,
  ControlPlaneSessionInfo,
} from "core/control-plane/AuthTypes";
import fetch from "node-fetch";
import {
  authentication,
  AuthenticationProvider,
  AuthenticationProviderAuthenticationSessionsChangeEvent,
  AuthenticationSession,
  Disposable,
  EventEmitter,
  ExtensionContext,
  window,
  workspace,
} from "vscode";
import { SecretStorage } from "./SecretStorage";
import { UriEventHandler } from "./uriHandler";

const ACCESS_TOKEN_TTL_MINUTES = 10;

interface ContinueAuthenticationSession {
  id: string;
  accessToken: string;
  account: {
    id: string;
    label: string;
  };
  scopes: string[];
  refreshToken: string;
  expiresAt: number;
  loginNeeded: boolean;
}

interface LdapAuthResponse {
  success: boolean;
  user: {
    username: string;
    email: string;
    displayName: string;
    groups: string[];
  };
  tokens: {
    accessToken: string;
    refreshToken?: string;
  };
}

interface LogoutRequest {
  refresh_token: string;
}

export async function getLdapSessionInfo(
  silent: boolean,
  useOnboarding: boolean,
): Promise<ControlPlaneSessionInfo | undefined> {
  try {
    const session = await authentication.getSession("ldap", [], {
      silent: silent,
      createIfNone: !silent,
    });

    if (!session) return undefined;

    return {
      AUTH_TYPE: "ldap" as AuthType,
      accessToken: session.accessToken,
      account: {
        id: session.account.id,
        label: session.account.label,
      },
    };
  } catch (error) {
    return undefined;
  }
}

export class LdapAuthProvider implements AuthenticationProvider, Disposable {
  private _sessionChangeEmitter =
    new EventEmitter<AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private _disposable: Disposable;
  private _refreshInterval: NodeJS.Timeout | null = null;
  private _isRefreshing = false;
  private secretStorage: SecretStorage;
  private readonly serverUrl: string;

  constructor(
    private readonly context: ExtensionContext,
    private readonly _uriHandler: UriEventHandler,
  ) {
    const config = workspace.getConfiguration("continue");
    this.serverUrl = config.get<string>("ldapServerUrl", "http://cv7gpufarm:8003");

    this._disposable = Disposable.from(
      authentication.registerAuthenticationProvider(
        "ldap",
        "Continue LDAP",
        this,
        { supportsMultipleAccounts: false },
      ),
      window.registerUriHandler(this._uriHandler),
    );

    this.secretStorage = new SecretStorage(context);

    this._refreshInterval = setInterval(
      () => {
        void this.refreshSessions();
      },
      1000 * 60 * 10,
    );
  }

  get onDidChangeSessions() {
    return this._sessionChangeEmitter.event;
  }

  async createSession(
    scopes: string[],
  ): Promise<ContinueAuthenticationSession> {
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      console.log("LDAP Session attempt", attempts + 1);
      
      const username = await window.showInputBox({
        prompt: attempts === 0 
          ? "Enter LDAP username" 
          : "Invalid credentials. Enter LDAP username",
        password: false,
      });

      if (!username) {
        throw new Error("Username required");
      }

      const password = await window.showInputBox({
        prompt: "Enter LDAP password",
        password: true,
      });

      if (!password) {
        throw new Error("Password required");
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(`${this.serverUrl}/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const  data = (await response.json()) as LdapAuthResponse;

          const session: ContinueAuthenticationSession = {
            id: username,
            account: {
              id: username,
              label: data.user.displayName || username,
            },
            scopes: [],
            accessToken: data.tokens.accessToken,
            refreshToken: data.tokens.refreshToken || "",
            expiresAt: Date.now() + (ACCESS_TOKEN_TTL_MINUTES * 60 * 1000),
            loginNeeded: false,
          };

          await this.storeSessions([session]);
          return session;
        } else {
          let errorMessage = "Invalid credentials";
          try {
            const errorData = await response.json().catch(() => ({}));
            errorMessage = errorData.detail || errorMessage;
          } catch {}

          if (attempts < maxAttempts - 1) {
            await window.showErrorMessage(`Login failed: ${errorMessage}. Please try again.`);
            attempts++;
            continue;
          } else {
            throw new Error(errorMessage);
          }
        }
      } catch (error) {
        clearTimeout(timeoutId);
        if (attempts < maxAttempts - 1) {
          await window.showErrorMessage("Connection failed. Please try again.");
          attempts++;
          continue;
        } else {
          throw error;
        }
      }
    }

    throw new Error("Maximum login attempts exceeded");
  }

  public async removeSession(sessionId: string): Promise<void> {
    const sessions = await this.getSessions();
    const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
    const session = sessions[sessionIdx];
    
    if (!session) {
      return;
    }

    sessions.splice(sessionIdx, 1);
    await this.storeSessions(sessions);

    try {
      if (session.refreshToken) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        await fetch(`${this.serverUrl}/logout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: session.refreshToken }),
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
      }
    } catch (error) {
      console.warn("Server logout failed (continuing with local cleanup):", error);
    }

    this._sessionChangeEmitter.fire({
      added: [],
      removed: [session],
      changed: [],
    });
  }

  private async _refreshSession(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`${this.serverUrl}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.detail || "Token refresh failed";
        throw new Error(errorMessage);
      }

      const  data = (await response.json()) as LdapAuthResponse;
      return {
        accessToken: data.tokens.accessToken,
        refreshToken: data.tokens.refreshToken || refreshToken,
        expiresAt: Date.now() + (ACCESS_TOKEN_TTL_MINUTES * 60 * 1000),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async storeSessions(sessions: ContinueAuthenticationSession[]) {
    const data = JSON.stringify(sessions, null, 2);
    await this.secretStorage.store("ldap.sessions", data);
  }

  public async getSessions(): Promise<ContinueAuthenticationSession[]> {
    const data = await this.secretStorage.get("ldap.sessions");
    if (!data) return [];
    return JSON.parse(data) as ContinueAuthenticationSession[];
  }

  async refreshSessions() {
    if (this._isRefreshing) return;
    this._isRefreshing = true;

    try {
      const sessions = await this.getSessions();
      const refreshedSessions = [];

      for (const session of sessions) {
        if (session.expiresAt > Date.now()) {
          refreshedSessions.push(session);
          continue;
        }

        try {
          const refreshed = await this._refreshSession(session.refreshToken);
          refreshedSessions.push({
            ...session,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
          });
        } catch (error) {
          console.error("Failed to refresh session:", error);
          refreshedSessions.push(session);
        }
      }

      if (refreshedSessions.length > 0) {
        await this.storeSessions(refreshedSessions);
      }
    } finally {
      this._isRefreshing = false;
    }
  }

  public async handleTokenExpired(): Promise<boolean> {
    try {
      const sessions = await this.getSessions();
      if (sessions.length === 0) {
        return false;
      }

      const session = sessions[0];
      
      try {
        const refreshed = await this._refreshSession(session.refreshToken);
        const refreshedSession = {
          ...session,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
        };

        await this.storeSessions([refreshedSession]);
        
        this._sessionChangeEmitter.fire({
          added: [],
          removed: [],
          changed: [refreshedSession],
        });
        
        return true;
      } catch (refreshError) {
        console.error("Token refresh failed during 401 handling:", refreshError);
        await this.storeSessions([]);
        this._sessionChangeEmitter.fire({
          added: [],
          removed: [session],
          changed: [],
        });
        return false;
      }
    } catch (error) {
      console.error("Error handling token expired:", error);
      return false;
    }
  }

  dispose() {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
    }
    this._disposable.dispose();
  }
}