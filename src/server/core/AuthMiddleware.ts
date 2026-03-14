import type { AuthResult, AuthStrategy } from "../../auth/types.js";
import type { FunctionRegistry } from "./FunctionRegistry.js";
import type { Middleware, RequestContext } from "../utils/types.js";
import { authenticateRequest } from "./authenticateRequest.js";

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

  middleware(): Middleware {
    return async (ctx: RequestContext, next: () => Promise<Response>) => {
      const result = await authenticateRequest({
        request: ctx.request,
        functionName: ctx.functionName,
        auth: this.#auth,
        registry: this.#registry,
        publicFunctions: this.#publicFunctions,
        onAuthFailure: this.#onAuthFailure,
      });

      if (!result.authenticated) {
        return result.response;
      }

      ctx.authClaims = result.claims;
      return next();
    };
  }
}
