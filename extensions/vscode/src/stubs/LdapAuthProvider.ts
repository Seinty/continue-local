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
} from "vscode";
import { SecretStorage } from "./SecretStorage";
import { UriEventHandler } from "./uriHandler";

interface ContinueAuthenticationSession extends AuthenticationSession {
  refreshToken: string;
  expiresInMs: number;
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
    expiresIn: number;
  };
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

  constructor(
    private readonly context: ExtensionContext,
    private readonly _uriHandler: UriEventHandler,
  ) {
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
    console.log("LDAP Session");
    const username = await window.showInputBox({
      prompt: "Enter LDAP username",
      password: false,
    });

    const password = await window.showInputBox({
      prompt: "Enter LDAP password",
      password: true,
    });

    if (!username || !password) {
      throw new Error("Username and password required");
    }

    const response = await fetch("http://cv7gpufarm:8003/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (!response.ok) {
      throw new Error("LDAP authentication failed");
    }

    const data: LdapAuthResponse = (await response.json()) as LdapAuthResponse;

    const session: ContinueAuthenticationSession = {
      id: username,
      account: {
        id: username,
        label: data.user.displayName || username,
      },
      scopes: [],
      accessToken: data.tokens.accessToken,
      refreshToken: data.tokens.refreshToken || "",
      expiresInMs: data.tokens.expiresIn * 1000,
      loginNeeded: false,
    };

    await this.storeSessions([session]);
    return session;
  }

  public async removeSession(sessionId: string): Promise<void> {
    const sessions = await this.getSessions();
    const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
    const session = sessions[sessionIdx];
    sessions.splice(sessionIdx, 1);

    await this.storeSessions(sessions);

    if (session) {
      this._sessionChangeEmitter.fire({
        added: [],
        removed: [session],
        changed: [],
      });
    }
  }

  private async _refreshSession(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresInMs: number;
  }> {
    const response = await fetch("http://cv7gpufarm:8003/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) {
      throw new Error("Token refresh failed");
    }

    const data: LdapAuthResponse = (await response.json()) as LdapAuthResponse;
    return {
      accessToken: data.tokens.accessToken,
      refreshToken: data.tokens.refreshToken || refreshToken,
      expiresInMs: data.tokens.expiresIn * 1000,
    };
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
        try {
          const refreshed = await this._refreshSession(session.refreshToken);
          refreshedSessions.push({
            ...session,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresInMs: refreshed.expiresInMs,
          });
        } catch (error) {
          console.error("Failed to refresh session:", error);
        }
      }

      if (refreshedSessions.length > 0) {
        await this.storeSessions(refreshedSessions);
      }
    } finally {
      this._isRefreshing = false;
    }
  }

  dispose() {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
    }
    this._disposable.dispose();
  }
}
