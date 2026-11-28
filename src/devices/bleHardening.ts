/**
 * Bluetooth GATT hardening utilities:
 * - Step-labelled timeouts (8 s connect steps, 4 s writes) and bounded retries (up to 3 attempts)
 * - Coalescing ERG write queue that drops stale target power commands and never wedges on a stuck write
 * - FTMS Control Point (0x2AD9) 0x80 response code parser with exact "control not permitted" messaging
 */

export const BLE_CONNECT_TIMEOUT_MS = 8_000;
export const BLE_WRITE_TIMEOUT_MS = 4_000;
export const BLE_MAX_RETRIES = 3;

export const FTMS_OP_REQUEST_CONTROL = 0x00;
export const FTMS_OP_SET_TARGET_POWER = 0x05;
export const FTMS_OP_START_RESUME = 0x07;
export const FTMS_OP_STOP_PAUSE = 0x08;
export const FTMS_OP_RESPONSE_CODE = 0x80;

export const FTMS_RESULT_SUCCESS = 0x01;
export const FTMS_RESULT_OP_CODE_NOT_SUPPORTED = 0x02;
export const FTMS_RESULT_INVALID_PARAMETER = 0x03;
export const FTMS_RESULT_OPERATION_FAILED = 0x04;
export const FTMS_RESULT_CONTROL_NOT_PERMITTED = 0x05;

export const CONTROL_NOT_PERMITTED_MESSAGE =
  'Another app has control of the trainer. Close Wahoo, Zwift or TrainerRoad and retry.';

export interface FtmsControlPointResponse {
  requestOpCode: number;
  resultCode: number;
  success: boolean;
  controlNotPermitted: boolean;
  errorMessage: string | null;
}

export function parseFtmsControlPointResponse(
  view: DataView
): FtmsControlPointResponse | null {
  if (view.byteLength < 3) return null;
  const responseOpCode = view.getUint8(0);
  if (responseOpCode !== FTMS_OP_RESPONSE_CODE) return null;

  const requestOpCode = view.getUint8(1);
  const resultCode = view.getUint8(2);
  const success = resultCode === FTMS_RESULT_SUCCESS;
  const controlNotPermitted = resultCode === FTMS_RESULT_CONTROL_NOT_PERMITTED;

  let errorMessage: string | null = null;
  if (controlNotPermitted) {
    errorMessage = CONTROL_NOT_PERMITTED_MESSAGE;
  } else if (!success) {
    switch (resultCode) {
      case FTMS_RESULT_OP_CODE_NOT_SUPPORTED:
        errorMessage = `Trainer rejected FTMS command 0x${requestOpCode.toString(16).toUpperCase()}: OpCode not supported.`;
        break;
      case FTMS_RESULT_INVALID_PARAMETER:
        errorMessage = `Trainer rejected FTMS command 0x${requestOpCode.toString(16).toUpperCase()}: Invalid parameter.`;
        break;
      case FTMS_RESULT_OPERATION_FAILED:
        errorMessage = `Trainer reported FTMS command 0x${requestOpCode.toString(16).toUpperCase()} failed.`;
        break;
      default:
        errorMessage = `Trainer returned FTMS error code 0x${resultCode.toString(16).toUpperCase()} for command 0x${requestOpCode.toString(16).toUpperCase()}.`;
        break;
    }
  }

  return {
    requestOpCode,
    resultCode,
    success,
    controlNotPermitted,
    errorMessage,
  };
}

/**
 * Wrap any Bluetooth Promise with a strict timeout and a step-labelled Error.
 */
export function withBluetoothTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stepLabel: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`[BLE ${stepLabel}] Timed out after ${timeoutMs}ms`));
    }, Math.max(1, timeoutMs));

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('[BLE ')) {
          reject(err instanceof Error ? err : new Error(msg));
        } else {
          reject(new Error(`[BLE ${stepLabel}] ${msg}`));
        }
      }
    );
  });
}

export interface RetryOptions {
  stepLabel: string;
  timeoutMs: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

/**
 * Execute a Bluetooth GATT step with per-attempt timeout and up to N retries (default 3).
 * Never wraps navigator.bluetooth.requestDevice().
 */
export async function withBluetoothRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? BLE_MAX_RETRIES);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 120);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await withBluetoothTimeout(
        fn(),
        options.timeoutMs,
        `${options.stepLabel} (attempt ${attempt}/${maxAttempts})`
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts && retryDelayMs > 0) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }

  throw lastError ?? new Error(`[BLE ${options.stepLabel}] Failed after ${maxAttempts} attempts`);
}

interface QueuedCommand {
  kind: 'control' | 'targetPower';
  label: string;
  watts?: number;
  execute: () => Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAtMs: number;
}

export interface CoalescingQueueOptions {
  writeTimeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  onWriteLatency?: (latencyMs: number, label: string) => void;
  onWriteError?: (err: Error, label: string) => void;
}

/**
 * Coalescing BLE Control Point write queue:
 * - Discrete commands (requestControl, startResume, stopPause) execute FIFO.
 * - Target power commands coalesce: only the latest pending target power is kept;
 *   any older superseded pending target is immediately dropped.
 * - Each write is bounded by a 4 s timeout so a stuck GATT write never blocks later commands.
 */
export class CoalescingErgQueue {
  private controlQueue: QueuedCommand[] = [];
  private pendingTarget: QueuedCommand | null = null;
  private draining = false;
  private writeTimeoutMs: number;
  private maxRetries: number;
  private retryDelayMs: number;
  private onWriteLatency?: (latencyMs: number, label: string) => void;
  private onWriteError?: (err: Error, label: string) => void;

  private droppedTargetsCount = 0;
  private lastWriteLatencyMs = 0;

  constructor(options: CoalescingQueueOptions = {}) {
    this.writeTimeoutMs = options.writeTimeoutMs ?? BLE_WRITE_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? BLE_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? 80;
    this.onWriteLatency = options.onWriteLatency;
    this.onWriteError = options.onWriteError;
  }

  getDroppedTargetsCount(): number {
    return this.droppedTargetsCount;
  }

  getLastWriteLatencyMs(): number {
    return this.lastWriteLatencyMs;
  }

  enqueueControl(label: string, execute: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.controlQueue.push({
        kind: 'control',
        label,
        execute,
        resolve,
        reject,
        enqueuedAtMs: Date.now(),
      });
      this.scheduleDrain();
    });
  }

  enqueueTargetPower(watts: number, execute: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.pendingTarget) {
        // Drop the stale pending target silently so only the latest target is written
        this.droppedTargetsCount += 1;
        this.pendingTarget.resolve();
      }
      this.pendingTarget = {
        kind: 'targetPower',
        label: `setTargetPower(${watts}W)`,
        watts,
        execute,
        resolve,
        reject,
        enqueuedAtMs: Date.now(),
      };
      this.scheduleDrain();
    });
  }

  clear(): void {
    for (const cmd of this.controlQueue) {
      cmd.resolve();
    }
    this.controlQueue = [];
    if (this.pendingTarget) {
      this.pendingTarget.resolve();
      this.pendingTarget = null;
    }
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.controlQueue.length > 0 || this.pendingTarget !== null) {
        let next: QueuedCommand | null = null;
        if (this.controlQueue.length > 0) {
          next = this.controlQueue.shift()!;
        } else if (this.pendingTarget !== null) {
          next = this.pendingTarget;
          this.pendingTarget = null;
        }
        if (!next) break;

        let succeeded = false;
        let lastErr: Error | null = null;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
          try {
            await withBluetoothTimeout(
              next.execute(),
              this.writeTimeoutMs,
              `${next.label} (attempt ${attempt}/${this.maxRetries})`
            );
            succeeded = true;
            break;
          } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err));
            // If a newer target power arrived while this target failed/timed out, abandon stale retries immediately
            if (next.kind === 'targetPower' && this.pendingTarget !== null) {
              this.droppedTargetsCount += 1;
              break;
            }
            if (attempt < this.maxRetries && this.retryDelayMs > 0) {
              await new Promise((r) => setTimeout(r, this.retryDelayMs));
            }
          }
        }

        if (succeeded) {
          const latencyMs = Math.max(0, Date.now() - next.enqueuedAtMs);
          this.lastWriteLatencyMs = latencyMs;
          this.onWriteLatency?.(latencyMs, next.label);
          next.resolve();
        } else {
          const error = lastErr ?? new Error(`[BLE ${next.label}] Write failed`);
          this.onWriteError?.(error, next.label);
          next.reject(error);
        }
      }
    } finally {
      this.draining = false;
      if (this.controlQueue.length > 0 || this.pendingTarget !== null) {
        this.scheduleDrain();
      }
    }
  }
}
