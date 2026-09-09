import type { DatabaseSync } from "node:sqlite";
import { DomainError, type JsonObject } from "./contracts.js";
import { hash } from "./engine.js";
import { AssetRegister } from "./asset-register.js";
import {
  purchaseIntegrity,
  purchasingAuthority,
  type PurchasingServices,
} from "./purchasing.js";
import {
  deliveryActions,
  deliveryDocumentKey,
} from "./purchase-delivery-models.js";
import type { Entity } from "./workspace.js";

type Row = Record<string, unknown>;
const object = (v: unknown) => v as JsonObject;
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
function fail(code: string, message: string): never {
  throw new DomainError(code, message, 409);
}
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
export function migratePurchaseDeliveries(db: DatabaseSync) {
  db.exec(`CREATE UNIQUE INDEX ops_delivery_document_line ON ops_entities(
    tenant_id,json_extract(data_json,'$.supplierId'),json_extract(data_json,'$.documentKey'),json_extract(data_json,'$.documentLine'))
    WHERE module='purchases' AND json_extract(data_json,'$.kind')='receipt';
    CREATE INDEX ops_delivery_order ON ops_entities(tenant_id,json_extract(data_json,'$.orderId'))
    WHERE module='purchases' AND json_extract(data_json,'$.kind')='receipt';`);
}
export interface DeliveryServices extends PurchasingServices {
  insertAsset(title: string, data: JsonObject): Entity;
}
export class PurchaseDeliveries {
  constructor(private db: DatabaseSync) {}
  read(
    tenant: string,
    id: string,
    module: "purchases" | "assets" = "purchases",
  ): Entity {
    const row = this.db
      .prepare(
        "SELECT * FROM ops_entities WHERE tenant_id=? AND module=? AND id=?",
      )
      .get(tenant, module, id) as Row | undefined;
    if (!row)
      throw new DomainError(
        "ENTITY_NOT_FOUND",
        "Brak właściwego rekordu w tej firmie.",
        404,
      );
    const entity: Entity = {
      id: String(row.id),
      module,
      title: String(row.title),
      status: String(row.status),
      version: Number(row.version),
      data: JSON.parse(String(row.data_json)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    const snapshot = this.db
      .prepare(
        "SELECT snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
      )
      .get(tenant, id, entity.version);
    if (
      snapshot?.snapshot_hash !== hash(entity) ||
      (module === "purchases" && !purchaseIntegrity(entity))
    )
      fail(
        "DELIVERY_STATE_INCONSISTENT",
        "Rejestr dostawy nie odpowiada zapisanej historii.",
      );
    return entity;
  }
  private receipts(tenant: string, order: Entity): Entity[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM ops_entities WHERE tenant_id=? AND module='purchases' AND json_extract(data_json,'$.kind')='receipt' AND json_extract(data_json,'$.orderId')=? ORDER BY id",
      )
      .all(tenant, order.id);
    if (rows.length > 500)
      fail("DELIVERY_LIMIT", "Zbyt wiele pozycji dostawy w zamówieniu.");
    const receipts = rows.map((r) => this.read(tenant, String(r.id)));
    for (const receipt of receipts) {
      const d = receipt.data,
        a = object(d.attestation),
        resolution = d.resolution ? object(d.resolution) : null;
      if (
        d.supplierId !== order.data.supplierId ||
        d.requestId !== order.data.requestId ||
        d.orderId !== order.id ||
        !a ||
        d.attestationHash !== hash(a) ||
        a.orderId !== order.id ||
        a.supplierId !== d.supplierId ||
        d.documentKey !== deliveryDocumentKey(String(a.documentNumber)) ||
        d.documentLine !== a.documentLine ||
        !integer(a.quantityReceived) ||
        Number(a.quantityReceived) < 1 ||
        !integer(a.quantityAccepted) ||
        Number(a.quantityAccepted) > Number(a.quantityReceived) ||
        !integer(a.replacesLegacyQuantity) ||
        Number(a.replacesLegacyQuantity) > Number(a.quantityAccepted) ||
        !a.requestedBy ||
        !a.approvedBy ||
        !a.runId ||
        !a.stepId ||
        !a.operationKey ||
        (Number(a.quantityAccepted) < Number(a.quantityReceived) &&
          !a.rejectionReason)
      )
        fail(
          "DELIVERY_STATE_INCONSISTENT",
          "Poświadczenie pozycji dostawy jest niespójne.",
        );
      if (
        resolution &&
        (resolution.kind !== "returned_to_supplier" ||
          resolution.quantity !==
            Number(a.quantityReceived) - Number(a.quantityAccepted) ||
          !resolution.requestedBy ||
          !resolution.approvedBy ||
          !resolution.evidenceNote ||
          !resolution.returnReference ||
          String(resolution.returnedOn) < String(a.receivedOn))
      )
        fail(
          "DELIVERY_STATE_INCONSISTENT",
          "Rozstrzygnięcie rozbieżności nie odpowiada poświadczeniu.",
        );
      if (
        receipt.status !==
        (Number(a.quantityReceived) > Number(a.quantityAccepted) && !resolution
          ? "needs_resolution"
          : "confirmed")
      )
        fail(
          "DELIVERY_STATE_INCONSISTENT",
          "Stan pozycji nie odpowiada rozbieżnościom.",
        );
      const assets = list(d.assetIds);
      if (
        new Set(assets).size !== assets.length ||
        assets.length > Number(a.quantityAccepted)
      )
        fail(
          "DELIVERY_STATE_INCONSISTENT",
          "Wyposażenie przekracza poświadczoną ilość.",
        );
      for (const [index, id] of assets.entries()) {
        const asset = this.read(tenant, id, "assets"),
          origin = object(asset.data.purchaseOrigin);
        if (
          !origin ||
          origin.receiptId !== receipt.id ||
          origin.orderId !== order.id ||
          origin.attestationHash !== d.attestationHash ||
          origin.unit !== index + 1 ||
          !new AssetRegister(this.db).verify(tenant, asset)
        )
          fail(
            "DELIVERY_STATE_INCONSISTENT",
            "Pochodzenie urządzenia lub historia ewidencji jest niespójna.",
          );
      }
    }
    return receipts;
  }
  private totals(order: Entity, receipts: Entity[]) {
    const legacy = Number(
      order.data.deliveryRegisterVersion === 1
        ? order.data.legacyReportedQuantity
        : (order.data.receivedQuantity ?? 0),
    );
    if (!integer(legacy) || legacy > Number(order.data.quantity))
      fail("DELIVERY_STATE_INCONSISTENT", "Niepoprawna ilość historyczna.");
    let physical = legacy,
      accepted = legacy,
      confirmed = 0,
      rejected = 0,
      unresolved = 0,
      remainingLegacy = legacy;
    for (const r of receipts) {
      const a = object(r.data.attestation),
        replaced = Number(a.replacesLegacyQuantity),
        bad = Number(a.quantityReceived) - Number(a.quantityAccepted);
      physical += Number(a.quantityReceived) - replaced;
      accepted += Number(a.quantityAccepted) - replaced;
      confirmed += Number(a.quantityAccepted);
      remainingLegacy -= replaced;
      rejected += bad;
      if (!r.data.resolution) unresolved += bad;
    }
    if (
      remainingLegacy < 0 ||
      accepted > Number(order.data.quantity) ||
      ![physical, accepted, confirmed, rejected, unresolved].every(integer)
    )
      fail(
        "DELIVERY_STATE_INCONSISTENT",
        "Ilości dostaw nie odpowiadają zamówieniu.",
      );
    return {
      physicalQuantity: physical,
      acceptedQuantity: accepted,
      confirmedQuantity: confirmed,
      rejectedQuantity: rejected,
      unresolvedQuantity: unresolved,
      unverifiedLegacyQuantity: remainingLegacy,
      outstandingQuantity: Number(order.data.quantity) - accepted,
    };
  }
  projection(tenant: string, orderId: string) {
    const order = this.read(tenant, orderId);
    if (order.data.kind !== "order")
      fail("WRONG_RECORD_KIND", "Wskaż zamówienie.");
    const receipts = this.receipts(tenant, order),
      totals = this.totals(order, receipts);
    if (order.data.deliveryRegisterVersion === 1) {
      if (
        hash(list(order.data.receiptIds).sort()) !==
          hash(receipts.map((r) => r.id).sort()) ||
        hash(order.data.deliveryTotals) !== hash(totals) ||
        order.data.receivedQuantity !== totals.acceptedQuantity ||
        order.status !== this.status(totals)
      )
        fail(
          "DELIVERY_STATE_INCONSISTENT",
          "Podsumowanie zamówienia nie odpowiada niezależnemu odczytowi dostaw.",
        );
    } else if (receipts.length)
      fail(
        "DELIVERY_STATE_INCONSISTENT",
        "Brak zapisanej wersji rejestru dostaw.",
      );
    const request =
      typeof order.data.requestId === "string"
        ? this.read(tenant, order.data.requestId)
        : null;
    const identity: JsonObject = {
      orderId: order.id,
      requestId: request?.id ?? null,
      requestRevision: order.data.requestRevision ?? null,
      caseId: request?.data.caseId ?? null,
      caseScopeRevision: request?.data.caseScopeRevision ?? null,
      caseRequirementId: request?.data.caseRequirementId ?? null,
      costDecisionHash: object(order.data.costDecision)?.hash ?? null,
      quantity: order.data.quantity!,
      ...totals,
      receipts: receipts.map((r) => ({
        id: r.id,
        attestationHash: r.data.attestationHash!,
        resolution: r.data.resolution ?? null,
      })),
      current:
        order.status === "received" &&
        order.data.deliveryRegisterVersion === 1 &&
        totals.outstandingQuantity === 0 &&
        totals.unresolvedQuantity === 0 &&
        totals.unverifiedLegacyQuantity === 0 &&
        receipts.length > 0,
    };
    return {
      order,
      receipts,
      totals,
      proof: {
        title: order.title,
        version: Number(order.data.deliveryEvidenceVersion ?? order.version),
        revision: null,
        identity,
        hash: hash(identity),
      },
    };
  }
  private status(t: ReturnType<PurchaseDeliveries["totals"]>) {
    return t.unresolvedQuantity > 0
      ? "needs_resolution"
      : t.outstandingQuantity === 0
        ? "received"
        : "part_received";
  }
  private updateOrder(s: DeliveryServices, order: Entity, receipts: Entity[]) {
    order.data.deliveryRegisterVersion = 1;
    order.data.legacyReportedQuantity ??= Number(
      order.data.receivedQuantity ?? 0,
    );
    const totals = this.totals(order, receipts);
    order.data.receiptIds = receipts.map((r) => r.id);
    order.data.deliveryTotals = totals;
    order.data.receivedQuantity = totals.acceptedQuantity;
    order.data.deliveryEvidenceVersion = order.version + 1;
    order.status = this.status(totals);
    return s.save(order);
  }
  change(
    s: DeliveryServices,
    entity: Entity,
    action: string,
    raw: JsonObject,
  ): Entity {
    const schema = deliveryActions[action as keyof typeof deliveryActions];
    if (!schema) fail("DELIVERY_ACTION", "Nieobsługiwana operacja dostawy.");
    const input = schema.parse(raw) as unknown as JsonObject;
    purchasingAuthority(s);
    const view = this.projection(s.ctx.tenantId, entity.id),
      order = view.order;
    if (order.version !== input.expectedVersion)
      fail("VERSION_CONFLICT", "Zamówienie zmieniło wersję.");
    if (["cancelled", "draft", "ordered"].includes(order.status))
      fail(
        "INVALID_TRANSITION",
        "Dostawa wymaga potwierdzenia dostawcy i otwartego zamówienia.",
      );
    if (action === "recordDelivery") {
      const key = deliveryDocumentKey(String(input.documentNumber));
      if (
        this.db
          .prepare(
            "SELECT id FROM ops_entities WHERE tenant_id=? AND module='purchases' AND json_extract(data_json,'$.kind')='receipt' AND json_extract(data_json,'$.supplierId')=? AND json_extract(data_json,'$.documentKey')=? AND json_extract(data_json,'$.documentLine')=?",
          )
          .get(
            s.ctx.tenantId,
            String(order.data.supplierId),
            key,
            Number(input.documentLine),
          )
      )
        fail(
          "DUPLICATE_DELIVERY",
          "Ta pozycja dokumentu dostawcy jest już zapisana. Ilość nie została ponownie naliczona.",
        );
      if (view.receipts.length >= 500)
        fail(
          "DELIVERY_LIMIT",
          "Zamówienie osiągnęło limit 500 pozycji przyjęcia.",
        );
      if (
        String(input.receivedOn) > s.day ||
        String(input.receivedOn) <
          String(object(order.data.acknowledgment).date)
      )
        fail(
          "INVALID_DELIVERY_DATE",
          "Data dostawy musi być rzeczywista i nie wcześniejsza od potwierdzenia dostawcy.",
        );
      if (
        Number(input.replacesLegacyQuantity) >
        view.totals.unverifiedLegacyQuantity
      )
        fail(
          "LEGACY_DELIVERY_EXCEEDED",
          "Ilość do uzupełnienia dowodem przekracza pozostałą historyczną ilość.",
        );
      if (
        Number(input.quantityAccepted) - Number(input.replacesLegacyQuantity) >
        view.totals.outstandingQuantity
      )
        fail(
          "DELIVERY_EXCEEDS_ORDER",
          "Przyjęta ilość przekracza zamówienie. Nadwyżkę odnotuj jako odrzuconą; dodatkowy zakup wymaga osobnej decyzji kosztowej.",
        );
      const {
        id: _id,
        expectedVersion: _version,
        humanConfirmed: _human,
        ...fields
      } = input;
      const attestation: JsonObject = {
        ...fields,
        orderId: order.id,
        supplierId: order.data.supplierId!,
        requestedBy: s.ctx.actorId!,
        approvedBy: s.ctx.approvedBy!,
        recordedAt: s.now,
        runId: s.ctx.runId,
        stepId: s.ctx.stepId,
        operationKey: s.ctx.operationKey,
      };
      const receipt = s.insert(
        `Przyjęcie: ${input.documentNumber} / ${input.documentLine}`,
        {
          kind: "receipt",
          orderId: order.id,
          ...(order.data.requestId ? { requestId: order.data.requestId } : {}),
          supplierId: order.data.supplierId!,
          documentKey: key,
          documentLine: input.documentLine!,
          attestation,
          attestationHash: hash(attestation),
          resolution: null,
          assetIds: [],
        },
        Number(input.quantityReceived) > Number(input.quantityAccepted)
          ? "needs_resolution"
          : "confirmed",
      );
      return this.updateOrder(s, order, [...view.receipts, receipt]);
    }
    const receipt = view.receipts.find((r) => r.id === input.receiptId);
    if (!receipt)
      fail("RECEIPT_NOT_FOUND", "Pozycja dostawy nie należy do zamówienia.");
    if (receipt.version !== input.expectedReceiptVersion)
      fail("VERSION_CONFLICT", "Pozycja dostawy zmieniła wersję.");
    const a = object(receipt.data.attestation);
    if (action === "returnRejectedDelivery") {
      if (receipt.status !== "needs_resolution" || receipt.data.resolution)
        fail(
          "NO_DELIVERY_EXCEPTION",
          "Ta pozycja nie ma otwartej rozbieżności.",
        );
      if (
        String(input.returnedOn) > s.day ||
        String(input.returnedOn) < String(a.receivedOn)
      )
        fail(
          "INVALID_RETURN_DATE",
          "Zwrot musi nastąpić po dostawie i nie może być w przyszłości.",
        );
      receipt.data.resolution = {
        kind: "returned_to_supplier",
        quantity: Number(a.quantityReceived) - Number(a.quantityAccepted),
        returnedOn: input.returnedOn!,
        returnReference: input.returnReference!,
        evidenceNote: input.evidenceNote!,
        requestedBy: s.ctx.actorId!,
        approvedBy: s.ctx.approvedBy!,
        recordedAt: s.now,
        runId: s.ctx.runId,
        stepId: s.ctx.stepId,
        operationKey: s.ctx.operationKey,
      };
      receipt.status = "confirmed";
      s.save(receipt);
      return this.updateOrder(s, order, view.receipts);
    }
    const items = input.assets as JsonObject[],
      previous = list(receipt.data.assetIds),
      firstUnit = previous.length;
    if (previous.length + items.length > Number(a.quantityAccepted))
      fail(
        "RECEIPT_ASSETS_EXCEEDED",
        "Liczba urządzeń przekracza przyjęte sztuki tej pozycji.",
      );
    for (const [index, item] of items.entries()) {
      if (order.data.assetType && item.assetType !== order.data.assetType)
        fail(
          "DELIVERED_ASSET_TYPE_MISMATCH",
          "Typ sprzętu nie odpowiada zatwierdzonemu zamówieniu.",
        );
      const { title, ...data } = item;
      const asset = s.insertAsset(String(title), {
        ...data,
        condition: "good",
        purchaseOrigin: {
          orderId: order.id,
          receiptId: receipt.id,
          attestationHash: receipt.data.attestationHash!,
          unit: firstUnit + index + 1,
        },
      });
      previous.push(asset.id);
    }
    receipt.data.assetIds = previous;
    receipt.data.lastAssetRegistration = {
      note: input.evidenceNote!,
      requestedBy: s.ctx.actorId!,
      approvedBy: s.ctx.approvedBy!,
      at: s.now,
    };
    return s.save(receipt);
  }
}
