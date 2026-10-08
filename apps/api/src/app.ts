import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { AppError } from "./lib/errors.js";
import { registerRoutes } from "./routes/index.js";
import { sweepStaleOperations } from "./services/operations.js";
import { evaluateNodeLiveness } from "./services/nodes.js";
import { runHealthProbes } from "./services/health-engine.js";
import { config } from "./config.js";
import { SECURITY_HEADERS } from "./lib/security.js";

export interface BuildAppOptions {
  /** Disable background jobs (tests). */
  backgroundJobs?: boolean;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
  });
  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: "1 minute",
  });

  // Applied to every response, including errors: the control plane must never
  // be indexed, framed, sniffed or cached (spec §15).
  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({
        error: {
          message: error.message,
          details: error.details ?? null,
        },
      });
      return;
    }
    if (error instanceof ZodError) {
      reply.code(422).send({
        error: {
          message: "Validation failed",
          details: error.flatten(),
        },
      });
      return;
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      reply.code(429).send({ error: { message: "Too many requests. Slow down and try again." } });
      return;
    }
    console.error("[api] unhandled error:", error);
    reply.code(500).send({
      error: {
        message: "Internal control plane error. Check the API logs for details.",
      },
    });
  });

  registerRoutes(app);

  if (opts.backgroundJobs !== false) {
    const interval = setInterval(() => {
      evaluateNodeLiveness().catch((err) => {
        console.error("[jobs] node liveness sweep failed:", (err as Error).message);
      });
      sweepStaleOperations().catch((err) => {
        console.error("[jobs] operation sweep failed:", (err as Error).message);
      });
      // Adaptive path probing: only tunnels whose measurement has aged past
      // their state-dependent interval are queued, and never twice in flight.
      runHealthProbes().catch((err) => {
        console.error("[jobs] health sweep failed:", (err as Error).message);
      });
    }, 30_000);
    interval.unref();
  }

  return app;
}
