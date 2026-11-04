import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AppError } from "./store.js";

export class Gateway extends EventEmitter {
  child?: ChildProcessWithoutNullStreams;
  ready = false;
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    private binary = process.env.GATEWAY_BIN ??
      join(process.cwd(), "gateway/target/release/family-matrix-gateway"),
  ) {
    super();
  }
  async start() {
    if (this.child) throw new Error("Gateway already started.");
    const child = spawn(this.binary, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) {
        child.kill();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.v !== 1) throw new Error("Unsupported Matrix protocol.");
          if (typeof msg.id === "string") {
            const p = this.pending.get(msg.id);
            if (p) {
              clearTimeout(p.timer);
              this.pending.delete(msg.id);
              if (msg.ok) p.resolve(msg.result);
              else
                p.reject(
                  new AppError(
                    502,
                    msg.error?.message ?? "Matrix operation failed.",
                  ),
                );
            }
          } else this.emit("event", msg);
        } catch {
          child.kill();
        }
      }
    });
    // Gateway stderr contains operational diagnostics only. Never echo requests or credentials.
    child.stderr.pipe(process.stderr, { end: false });
    const exited = (e?: Error) => {
      if (this.child !== child) return;
      this.ready = false;
      this.child = undefined;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(e ?? new Error("Matrix Gateway stopped."));
      }
      this.pending.clear();
      this.emit("crash", e);
    };
    child.once("error", exited);
    child.once("exit", () => exited());
    child.stdin.on("error", (error) => {
      exited(error);
      child.kill();
    });
    child.stdout.on("error", (error) => {
      exited(error);
      child.kill();
    });
    try {
      await this.request("status", {}, 15_000);
      this.ready = true;
    } catch (e) {
      child.kill("SIGKILL");
      this.child = undefined;
      throw e;
    }
  }
  request(
    op: string,
    args: Record<string, unknown> = {},
    timeout = 90_000,
  ): Promise<any> {
    const child = this.child;
    if (!child || child.killed)
      return Promise.reject(
        new AppError(503, "Matrix Gateway is unavailable."),
      );
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError(504, `Matrix ${op} timed out.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        JSON.stringify({ v: 1, id, op, ...args }) + "\n",
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }
  async close() {
    const c = this.child;
    if (!c) return;
    try {
      await this.request("shutdown", {}, 10_000);
    } catch {}
    await new Promise<void>((resolve) => {
      if (c.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        c.kill("SIGKILL");
        resolve();
      }, 5000);
      c.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.ready = false;
  }
}
