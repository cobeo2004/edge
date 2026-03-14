import type { AuthResult, AuthStrategy } from "../../auth/types.js";
import type { FunctionRegistry } from "./FunctionRegistry.js";

export type AuthenticateSuccess = {
  authenticated: true;
  claims?: Record<string, unknown>;
};
export type AuthenticateFailure = {
  authenticated: false;
  response: Response;
};
export type AuthenticateResult = AuthenticateSuccess | AuthenticateFailure;

export interface AuthenticateOptions {
  request: Request;
  functionName: string;
  auth: AuthStrategy;
  registry: FunctionRegistry;
  publicFunctions: string[];
  onAuthFailure?: (
    request: Request,
    error: AuthResult,
  ) => Response | Promise<Response>;
}

function unauthorizedResponse(
  result: AuthResult,
  request: Request,
  onAuthFailure?: AuthenticateOptions["onAuthFailure"],
): Response | Promise<Response> {
  if (onAuthFailure) {
    return onAuthFailure(request, result);
  }
  return new Response(
    JSON.stringify({
      error: "Unauthorized",
      message: result.error,
    }),
    {
      status: 401,
      headers: { "Content-Type": "application/json" },
    },
  );
}

export async function authenticateRequest(
  options: AuthenticateOptions,
): Promise<AuthenticateResult> {
  const { request, functionName, auth, registry, publicFunctions, onAuthFailure } = options;

  const isPublic =
    publicFunctions.includes(functionName) ||
    registry.getFunctionConfig(functionName)?.auth === false;

  if (isPublic) {
    return { authenticated: true };
  }

  let credentials: string | null;
  try {
    credentials = await auth.extractCredentials(request);
  } catch (err) {
    const result: AuthResult = {
      valid: false,
      error: err instanceof Error ? err.message : "Credential extraction failed",
    };
    return { authenticated: false, response: await unauthorizedResponse(result, request, onAuthFailure) };
  }

  if (!credentials) {
    const result: AuthResult = {
      valid: false,
      error: "No credentials provided",
    };
    return { authenticated: false, response: await unauthorizedResponse(result, request, onAuthFailure) };
  }

  let authResult: AuthResult;
  try {
    authResult = await auth.verify(credentials);
  } catch (err) {
    authResult = {
      valid: false,
      error: err instanceof Error ? err.message : "Verification failed",
    };
  }

  if (!authResult.valid) {
    return { authenticated: false, response: await unauthorizedResponse(authResult, request, onAuthFailure) };
  }

  return { authenticated: true, claims: authResult.claims };
}
