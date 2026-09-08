import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DomainError,
  type Principal,
  type ToolDefinition,
  type JsonObject,
} from "./contracts.js";
import { Engine } from "./engine.js";
import { WorkspaceStore } from "./workspace.js";
import { Conversations } from "./assistant.js";
import { InitiativeStore } from "./initiative.js";
import { Diagnostics } from "./diagnostics.js";
import { baselineProcessTemplates } from "./workspace-models.js";
import {
  exportArtifact,
  materializeArtifact,
  documentTemplates,
  prepareDocument,
} from "./artifacts.js";

export interface WorkspaceApiOptions {
  workspace: WorkspaceStore;
  engine: Engine;
  tools: ToolDefinition[];
  principal: (req: FastifyRequest) => Principal;
  conversations?: Conversations;
  diagnostics?: Diagnostics;
  initiatives?: InitiativeStore;
  dataDir?: string;
  principals?: (tenantId: string) => Principal[];
}
export function registerWorkspaceApi(
  app: FastifyInstance,
  {
    workspace,
    engine,
    tools,
    principal,
    conversations,
    diagnostics,
    initiatives,
    dataDir,
    principals,
  }: WorkspaceApiOptions,
) {
  const moduleParam = (req: FastifyRequest) =>
    z.object({ module: z.string().max(30) }).parse(req.params).module;
  app.get("/api/company/templates", async (req) => {
    const actor = principal(req);
    if (!(actor.scopes?.includes("*") || actor.scopes?.includes("company")))
      throw new DomainError(
        "SCOPE_REQUIRED",
        "Brak dostępu do konfiguracji firmy.",
        403,
      );
    return {
      templates: (["internal", "contractor"] as const).map((id) => ({
        id,
        label:
          id === "internal" ? "Pracownik wewnętrzny" : "Konsultant klienta",
        processTemplates: baselineProcessTemplates(id),
      })),
    };
  });
  app.get("/api/company/assignees", async (req) => {
    const actor = principal(req);
    if (!(actor.scopes?.includes("*") || actor.scopes?.includes("company")))
      throw new DomainError(
        "SCOPE_REQUIRED",
        "Brak dostępu do konfiguracji firmy.",
        403,
      );
    return {
      assignees: (principals?.(actor.tenantId) ?? [])
        .filter(
          (account) =>
            account.tenantId === actor.tenantId &&
            account.roles.includes("operator"),
        )
        .map((account) => ({ id: account.id, label: account.id })),
    };
  });
  app.get("/api/people/:id/episodes", async (req) => {
    const actor = principal(req);
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    return {
      episodes: workspace.listEmploymentEpisodes(actor, id).map((episode) => {
        let engagementLabel: string | undefined;
        if (episode.engagementRef) {
          try {
            engagementLabel = workspace.get(
              actor,
              episode.engagementRef.module,
              episode.engagementRef.id,
            ).title;
          } catch (error) {
            if (
              !(error instanceof DomainError) ||
              ![403, 404].includes(error.statusCode)
            )
              throw error;
          }
        }
        return { ...episode, ...(engagementLabel ? { engagementLabel } : {}) };
      }),
    };
  });
  app.get("/api/tasks", async (req) => ({
    tasks: workspace.listTasks(principal(req)),
  }));
  app.get("/api/tasks/:id/equipment", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { equipment: workspace.taskEquipment(principal(req), id) };
  });
  app.get("/api/assets/:id/custodians", async (req) => {
    const actor = principal(req),
      { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    workspace.get(actor, "assets", id);
    if (!actor.roles.includes("operator"))
      throw new DomainError(
        "FORBIDDEN",
        "Wybór opiekuna wymaga roli operatora.",
        403,
      );
    return {
      assignees: (principals?.(actor.tenantId) ?? [])
        .filter(
          (p) =>
            p.tenantId === actor.tenantId &&
            p.roles.includes("operator") &&
            (p.scopes?.includes("*") || p.scopes?.includes("assets")),
        )
        .map((p) => ({ id: p.id, label: p.id })),
    };
  });
  app.get("/api/assets/:id/register", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const page = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
      })
      .strict()
      .parse(req.query);
    return { register: workspace.assetRegister(principal(req), id, page) };
  });
  app.get("/api/assets/:id/custody", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const page = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
      })
      .strict()
      .parse(req.query);
    return { custody: workspace.assetCustody(principal(req), id, page) };
  });
  app.get("/api/task-assignees", async (req) => {
    const actor = principal(req);
    const { taskId } = z
      .object({ taskId: z.string().uuid() })
      .strict()
      .parse(req.query);
    return { assignees: workspace.taskAssignees(actor, taskId) };
  });
  app.get("/api/cases/:id/readiness", async (req) => ({
    readiness: workspace.readiness(
      principal(req),
      z.object({ id: z.string().uuid() }).parse(req.params).id,
    ),
  }));
  app.get("/api/cases/:id/access", async (req) => ({
    access: workspace.caseAccess(
      principal(req),
      z.object({ id: z.string().uuid() }).parse(req.params).id,
    ),
  }));
  app.get("/api/cases/:id/owners", async (req) => {
    const actor = principal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    workspace.get(actor, "cases", id);
    if (!actor.roles.includes("operator"))
      throw new DomainError(
        "FORBIDDEN",
        "Wybór właściciela wymaga roli operatora.",
        403,
      );
    return {
      assignees: (principals?.(actor.tenantId) ?? [])
        .filter((candidate) => {
          if (
            candidate.tenantId !== actor.tenantId ||
            !candidate.roles.includes("operator")
          )
            return false;
          try {
            workspace.get(candidate, "cases", id);
            return true;
          } catch (error) {
            if (error instanceof DomainError && error.statusCode === 403)
              return false;
            throw error;
          }
        })
        .map((candidate) => ({ id: candidate.id, label: candidate.id })),
    };
  });
  app.get("/api/workspace", async (req) => {
    const actor = principal(req);
    return {
      catalog: workspace
        .catalog()
        .filter(
          (m) => actor.scopes?.includes("*") || actor.scopes?.includes(m.id),
        ),
      summary: workspace.summary(actor),
    };
  });
  app.get("/api/workspace/:module", async (req) => ({
    items: workspace.list(principal(req), moduleParam(req)),
  }));
  app.get("/api/workspace/:module/:id", async (req) => {
    const { module, id } = z
      .object({ module: z.string(), id: z.string().uuid() })
      .parse(req.params);
    return { item: workspace.get(principal(req), module, id) };
  });
  for (const module of ["documents", "cases"] as const)
    app.get(
      module === "documents"
        ? "/api/documents/:id/export"
        : "/api/cases/:id/package",
      async (req, reply) => {
        const actor = principal(req);
        const artifact = exportArtifact(
          workspace,
          actor,
          module,
          z.object({ id: z.string().uuid() }).parse(req.params).id,
        );
        if (dataDir) materializeArtifact(dataDir, artifact);
        return reply
          .header(
            "Content-Disposition",
            `attachment; filename="${artifact.filename}"`,
          )
          .header("X-Content-SHA256", artifact.sha256)
          .type(artifact.contentType)
          .send(artifact.body);
      },
    );
  app.get("/api/document-templates", async (req) => {
    const actor = principal(req);
    return {
      templates: documentTemplates.filter(
        (t) =>
          actor.scopes?.includes("*") ||
          (actor.scopes?.includes("documents") &&
            actor.scopes?.includes(t.module)),
      ),
    };
  });
  app.post("/api/document-templates/prepare", async (req, reply) => {
    const actor = principal(req);
    const { templateId, sourceId, idempotencyKey } = z
      .object({
        templateId: z.string(),
        sourceId: z.string().uuid(),
        idempotencyKey: z.string().uuid(),
      })
      .strict()
      .parse(req.body);
    const request = `Dokument ze źródła ${templateId}:${sourceId}`;
    const previous = engine.replayRun(actor, request, idempotencyKey);
    if (previous) return reply.code(201).send({ run: previous });
    const input = prepareDocument(workspace, actor, templateId, sourceId);
    return reply.code(201).send({
      run: engine.createRun(
        actor,
        request,
        {
          title: String(input.title).slice(0, 160),
          summary:
            "Sprawdź treść i wersje źródeł przed zatwierdzeniem zapisu szkicu dokumentu.",
          steps: [
            {
              id: "document",
              title: "Zapisz szkic do akceptacji",
              toolId: "ops.documents.create",
              input,
            },
          ],
        },
        idempotencyKey,
      ),
    });
  });
  app.post("/api/commands", { bodyLimit: 80_000 }, async (req, reply) => {
    const actor = principal(req);
    const { toolId, input, idempotencyKey } = z
      .object({
        toolId: z.string().max(100),
        input: z.record(z.string(), z.json()),
        idempotencyKey: z.string().regex(/^[a-zA-Z0-9_:.-]{8,128}$/),
      })
      .strict()
      .parse(req.body);
    const tool = tools.find((t) => t.id === toolId);
    if (!tool) throw new DomainError("UNKNOWN_TOOL", "Nieznana operacja.");
    tool.inputSchema.parse(input);
    return reply.code(201).send({
      run: engine.createRun(
        actor,
        `Operacja ${tool.id}`,
        {
          title: tool.description.slice(0, 160),
          summary:
            "Sprawdź konkretny zakres operacji przed uruchomieniem i zatwierdzeniem zapisu.",
          steps: [
            {
              id: "command",
              title: tool.description.slice(0, 160),
              toolId,
              input: input as JsonObject,
            },
          ],
        },
        idempotencyKey,
      ),
    });
  });
  app.get("/api/ops", async (req) => {
    const actor = principal(req);
    return {
      ...diagnostics?.snapshot({
        databaseHealthy: true,
        queue: engine.queue(actor.tenantId),
      }),
      business: workspace.summary(actor),
      modelUsage: conversations?.usage(actor) ?? [],
      externalConnectionsEnabled: false,
    };
  });
  if (initiatives) {
    app.get("/api/initiatives", async (req) => {
      const actor = principal(req);
      const scan = initiatives.scan(actor);
      return { items: initiatives.list(actor), scan };
    });
    app.get("/api/profile", async (req) => ({
      profile: initiatives.profile(principal(req)),
    }));
  }
  if (conversations) {
    app.get("/api/conversations", async (req) => ({
      conversations: conversations.list(principal(req)),
    }));
    app.post("/api/conversations", async (req, reply) => {
      z.object({}).strict().parse(req.body);
      return reply
        .code(201)
        .send({ conversation: conversations.create(principal(req)) });
    });
    app.get("/api/conversations/:id", async (req) => ({
      conversation: conversations.get(
        principal(req),
        z.object({ id: z.string().uuid() }).parse(req.params).id,
      ),
    }));
    app.post("/api/conversations/:id/messages", async (req) => {
      const { message, idempotencyKey, choiceRef, expectedDraftVersion } = z
        .object({
          message: z.string().trim().min(1).max(4000),
          idempotencyKey: z.string().regex(/^[a-zA-Z0-9_:.-]{8,128}$/),
          choiceRef: z.string().min(1).max(240).optional(),
          expectedDraftVersion: z.number().int().nonnegative().optional(),
        })
        .strict()
        .parse(req.body);
      return {
        conversation: await conversations.message(
          principal(req),
          z.object({ id: z.string().uuid() }).parse(req.params).id,
          message,
          idempotencyKey,
          {
            ...(choiceRef ? { choiceRef } : {}),
            ...(expectedDraftVersion !== undefined
              ? { expectedDraftVersion }
              : {}),
          },
        ),
      };
    });
    app.post("/api/conversations/:id/resume", async (req) => {
      z.object({}).strict().parse(req.body);
      return {
        conversation: await conversations.resume(
          principal(req),
          z.object({ id: z.string().uuid() }).parse(req.params).id,
        ),
      };
    });
  }
}
