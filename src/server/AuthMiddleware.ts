import type { AuthResult, AuthStrategy } from "../auth/types.js";
import type { FunctionRegistry } from "./FunctionRegistry.js";
import type { Middleware, RequestContext } from "./types.js";

export interface AuthMiddlewareOptions {
  auth: AuthStrategy;
  registry: FunctionRegistry;
  publicFunctions?: string[];
  onAuthFailure?: (
    request: Request,
    error: AuthResult
  ) => Response | Promise<Response>;
}

export class AuthMiddleware {
  #auth: AuthStrategy;
  #registry: FunctionRegistry;
  #publicFunctions: string[];
  #onAuthFailure?: AuthMiddlewareOptions["onAuthFailure"];

  constructor(options: AuthMiddlewareOptions) {
    this.#auth = options.auth;
    this.#registry = options.registry;
    this.#publicFunctions = options.publicFunctions ?? [];
    this.#onAuthFailure = options.onAuthFailure;
  }

  #unauthorizedResponse(
    result: AuthResult,
    request: Request
  ): Response | Promise<Response> {
    if (this.#onAuthFailure) {
      return this.#onAuthFailure(request, result);
    }
    return new Response(
      JSON.stringify({
        error: "Unauthorized",
        message: result.error,
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  middleware(): Middleware {
    return async (ctx: RequestContext, next: () => Promise<Response>) => {
      const isPublic =
        this.#publicFunctions.includes(ctx.functionName) ||
        this.#registry.getFunctionConfig(ctx.functionName)?.auth === false;

      if (isPublic) {
        return next();
      }

      let credentials: string | null;
      try {
        credentials = await this.#auth.extractCredentials(ctx.request);
      } catch (err) {
        const result: AuthResult = {
          valid: false,
          error:
            err instanceof Error ? err.message : "Credential extraction failed",
        };
        return this.#unauthorizedResponse(result, ctx.request);
      }

      if (!credentials) {
        const result: AuthResult = {
          valid: false,
          error: "No credentials provided",
        };
        return this.#unauthorizedResponse(result, ctx.request);
      }

      let authResult: AuthResult;
      try {
        authResult = await this.#auth.verify(credentials);
      } catch (err) {
        authResult = {
          valid: false,
          error: err instanceof Error ? err.message : "Verification failed",
        };
      }

      if (!authResult.valid) {
        return this.#unauthorizedResponse(authResult, ctx.request);
      }

      ctx.authClaims = authResult.claims;
      return next();
    };
  }
}
