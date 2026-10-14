import { driveAsync, driveSync, type Job } from "./drive";
import { ActionHandlerError, AppNavError } from "./errors";
import { isThenable } from "./json";
import type { InstructionAction, InstructionStep, Instructions } from "./instructions";
import type { JsonObject } from "./types";

/**
 * Optional, opt-in execution layer. AppNav core never runs actions. Register
 * handlers explicitly by action type and pass generated instructions in.
 */

export interface HandlerContext<Ctx = unknown> {
  readonly action: Readonly<InstructionAction>;
  readonly step: Readonly<InstructionStep>;
  readonly instructions: Readonly<Instructions>;
  /** Caller supplied runtime context (navigation ref, driver, test harness, ...). */
  readonly context: Ctx;
  readonly attempt: number;
  /** 1 based position within the action's repeat count. Always 1 when the action has no `repeat`. */
  readonly iteration: number;
  /** The action's repeat count, or 1 when it has none. */
  readonly iterations: number;
  readonly signal?: AbortSignal;
}

export type ActionHandler<Ctx = unknown, R = unknown> = (ctx: HandlerContext<Ctx>) => R | PromiseLike<R>;

export interface HandlerOptions {
  /** Async execution only. Fails the attempt after this many milliseconds. */
  timeoutMs?: number;
  /** Extra attempts after the first failure. Default 0. */
  retries?: number;
  /** Async execution only. Delay between attempts. Default 0. */
  retryDelayMs?: number;
}

export interface ExecuteOptions<Ctx = unknown> {
  context?: Ctx;
  /** Keep running after a failed action. Default false. */
  continueOnError?: boolean;
  /** Skip actions without a handler instead of failing. Default false. */
  skipUnhandled?: boolean;
  signal?: AbortSignal;
  onAction?: (result: ActionResult, step: InstructionStep) => void;
}

export interface ActionResult {
  stepN: number;
  actionIndex: number;
  type: string;
  status: "ok" | "error" | "skipped";
  value?: unknown;
  error?: unknown;
  attempts: number;
  /** Only set for actions with a `repeat`: which repetition this result is (1 based). */
  iteration?: number;
}

export interface ExecutionResult {
  ok: boolean;
  results: ActionResult[];
}

interface Registered {
  handler: ActionHandler<never, unknown>;
  options: HandlerOptions;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Runtime<Ctx = unknown> {
  private readonly handlers = new Map<string, Registered>();

  register<T extends string = string>(type: T, handler: ActionHandler<Ctx>, options: HandlerOptions = {}): this {
    if (typeof handler !== "function") throw new ActionHandlerError("INVALID_HANDLER", `Handler for "${type}" must be a function`, [type]);
    this.handlers.set(type, { handler: handler as ActionHandler<never, unknown>, options });
    return this;
  }

  unregister(type: string): boolean {
    return this.handlers.delete(type);
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  /** Run instructions. Awaits async handlers and honours timeouts, retries and abort signals. */
  async execute(instructions: Instructions, options: ExecuteOptions<Ctx> = {}): Promise<ExecutionResult> {
    return driveAsync(this.job(instructions, options, true));
  }

  /** Run instructions with synchronous handlers only. Throws AsyncExtensionError if a handler returns a promise. */
  executeSync(instructions: Instructions, options: ExecuteOptions<Ctx> = {}): ExecutionResult {
    return driveSync(this.job(instructions, options, false));
  }

  private *job(instructions: Instructions, options: ExecuteOptions<Ctx>, allowAsync: boolean): Job<ExecutionResult> {
    const results: ActionResult[] = [];
    let ok = true;
    for (const step of instructions.steps) {
      for (let i = 0; i < step.actions.length; i++) {
        const action = step.actions[i] as InstructionAction;
        const reg = this.handlers.get(action.type);
        // An action with a `repeat` runs that many times in a row. A failed
        // repetition ends the run of that action, so it is never retried blindly.
        const iterations = reg ? Math.max(1, action.repeat ?? 1) : 1;
        for (let iteration = 1; iteration <= iterations; iteration++) {
          if (options.signal?.aborted) {
            throw new ActionHandlerError("ABORTED", "Execution aborted", [action.type]);
          }
          const tag = action.repeat === undefined ? {} : { iteration };
          let result: ActionResult;
          if (!reg) {
            if (options.skipUnhandled) result = { stepN: step.n, actionIndex: i, type: action.type, status: "skipped", attempts: 0 };
            else {
              result = {
                stepN: step.n,
                actionIndex: i,
                type: action.type,
                status: "error",
                error: new ActionHandlerError("NO_HANDLER", `No handler registered for action "${action.type}"`, [action.type]),
                attempts: 0,
              };
            }
          } else {
            const maxAttempts = 1 + Math.max(0, reg.options.retries ?? 0);
            let attempts = 0;
            result = { stepN: step.n, actionIndex: i, type: action.type, status: "error", attempts: 0, ...tag };
            while (attempts < maxAttempts) {
              attempts++;
              try {
                let value: unknown = (reg.handler as ActionHandler<Ctx>)({
                  action,
                  step,
                  instructions,
                  context: options.context as Ctx,
                  attempt: attempts,
                  iteration,
                  iterations,
                  signal: options.signal,
                });
                if (isThenable(value)) {
                  if (!allowAsync) {
                    yield { promise: value, what: `Handler for "${action.type}"` };
                  }
                  const timeout = reg.options.timeoutMs;
                  const pending: PromiseLike<unknown> =
                    timeout === undefined
                      ? value
                      : Promise.race([
                          value,
                          new Promise((_, rej) =>
                            setTimeout(() => rej(new ActionHandlerError("TIMEOUT", `Handler for "${action.type}" timed out after ${timeout}ms`, [action.type])), timeout),
                          ),
                        ]);
                  value = yield { promise: pending, what: `Handler for "${action.type}"` };
                }
                result = { stepN: step.n, actionIndex: i, type: action.type, status: "ok", value, attempts, ...tag };
                break;
              } catch (e) {
                if (e instanceof AppNavError && e.code === "ASYNC_IN_SYNC") throw e;
                result = { stepN: step.n, actionIndex: i, type: action.type, status: "error", error: e, attempts, ...tag };
                if (attempts < maxAttempts && allowAsync && reg.options.retryDelayMs) {
                  yield { promise: sleep(reg.options.retryDelayMs), what: "retry delay" };
                }
              }
            }
          }
          results.push(result);
          options.onAction?.(result, step);
          if (result.status === "error") {
            ok = false;
            if (!options.continueOnError) return { ok, results };
            break;
          }
        }
      }
    }
    return { ok, results };
  }
}

export function createRuntime<Ctx = unknown>(
  handlers: Record<string, ActionHandler<Ctx> | { handler: ActionHandler<Ctx>; options?: HandlerOptions }> = {},
): Runtime<Ctx> {
  const rt = new Runtime<Ctx>();
  for (const [type, h] of Object.entries(handlers)) {
    if (typeof h === "function") rt.register(type, h);
    else rt.register(type, h.handler, h.options);
  }
  return rt;
}

/** Shared runtime used by `registerActionHandler` for apps that prefer a global registry. */
export const defaultRuntime = new Runtime<unknown>();

export function registerActionHandler<T extends string = string>(type: T, handler: ActionHandler<unknown>, options?: HandlerOptions): void {
  defaultRuntime.register(type, handler, options);
}

export type { JsonObject };
