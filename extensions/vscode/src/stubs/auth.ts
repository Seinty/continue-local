import { EXTENSION_NAME } from "core/control-plane/env";
import * as vscode from "vscode";

export async function getUserToken(): Promise<string> {
  const session = await vscode.authentication.getSession("ldap", [], {
    createIfNone: false,
  });

  if (session) {
    return session.accessToken;
  }

  const settings = vscode.workspace.getConfiguration(EXTENSION_NAME);
  const userToken = settings.get<string | null>("userToken", null);
  if (userToken) {
    return userToken;
  }

  throw new Error("No authentication token found");
}
