import { randomUUID } from "node:crypto";
import type { WebSocketHooks } from "./WebSocketTypes.js";

export interface WebSocketProxyHandlerOptions extends WebSocketHooks {
  maxWebSocketConnections: number;
}

export class WebSocketProxyHandler {
  readonly #options: WebSocketProxyHandlerOptions;
  // functionName -> workerInstanceId -> Set<connectionId>
  readonly #connections = new Map<string, Map<string, Set<string>>>();

  constructor(options: WebSocketProxyHandlerOptions) {
    this.#options = options;
  }

  generateConnectionId(): string {
    return randomUUID();
  }

  addConnection(
    functionName: string,
    workerInstanceId: string,
    connectionId: string,
  ): void {
    if (!this.#connections.has(functionName)) {
      this.#connections.set(functionName, new Map());
    }
    const funcMap = this.#connections.get(functionName)!;
    if (!funcMap.has(workerInstanceId)) {
      funcMap.set(workerInstanceId, new Set());
    }
    funcMap.get(workerInstanceId)!.add(connectionId);
    this.#options.onWebSocketConnect?.(functionName, connectionId);
  }

  removeConnection(
    functionName: string,
    workerInstanceId: string,
    connectionId: string,
    code = 1005,
    reason = "",
  ): void {
    const funcMap = this.#connections.get(functionName);
    if (!funcMap) return;
    const workerSet = funcMap.get(workerInstanceId);
    if (!workerSet) return;
    workerSet.delete(connectionId);
    if (workerSet.size === 0) funcMap.delete(workerInstanceId);
    if (funcMap.size === 0) this.#connections.delete(functionName);
    this.#options.onWebSocketClose?.(functionName, connectionId, code, reason);
  }

  closeAllConnections(
    functionName: string,
    workerInstanceId: string,
    code: number,
    reason: string,
  ): void {
    const funcMap = this.#connections.get(functionName);
    if (!funcMap) return;
    const workerSet = funcMap.get(workerInstanceId);
    if (!workerSet) return;
    for (const connId of [...workerSet]) {
      this.removeConnection(functionName, workerInstanceId, connId, code, reason);
    }
  }

  closeAllConnectionsForFunction(
    functionName: string,
    code: number,
    reason: string,
  ): void {
    const funcMap = this.#connections.get(functionName);
    if (!funcMap) return;
    for (const workerId of [...funcMap.keys()]) {
      this.closeAllConnections(functionName, workerId, code, reason);
    }
  }

  getConnectionCount(
    functionName: string,
    workerInstanceId: string,
  ): number {
    return this.#connections.get(functionName)?.get(workerInstanceId)?.size ?? 0;
  }

  canAcceptConnection(
    functionName: string,
    workerInstanceId: string,
  ): boolean {
    return (
      this.getConnectionCount(functionName, workerInstanceId) <
      this.#options.maxWebSocketConnections
    );
  }

  emitError(
    functionName: string,
    connectionId: string,
    error: Error,
  ): void {
    this.#options.onWebSocketError?.(functionName, connectionId, error);
  }
}
