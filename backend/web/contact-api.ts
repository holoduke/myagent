import { IncomingMessage, ServerResponse } from "http";
import { syncContacts, findContacts, getAllContacts } from "../integrations/whatsapp.js";
import { getWhitelist, addToWhitelist, removeFromWhitelist, updatePermissions } from "../contact-whitelist.js";
import type { ContactPermissions } from "../contact-whitelist.js";
import { getActionableRequests, approveRequest, rejectRequest, getPendingCount } from "../actionable-tracker.js";
import type { ActionableRequestStatus } from "../actionable-tracker.js";
import { getDirectives, getDirectivesForContact, addDirective, updateDirective, removeDirective } from "../directives.js";
import type { DirectiveActionType, DirectivePolicy } from "../directives.js";
import {
  getReplyDirectives, addReplyDirective, updateReplyDirective, removeReplyDirective,
  getReplyLog, testReplyDirective,
} from "../reply-agent.js";
import type { ReplyCategory } from "../reply-agent.js";
import {
  getHandlers, addHandler, updateHandler, removeHandler,
  getHandlerLog, getHandlerStats, getHandlerFlags, testHandler,
} from "../message-handlers.js";
import type { HandlerScope, HandlerGate, HandlerAction } from "../message-handlers.js";
import { getRequests as getContactRequests, approveRequest as approveContactRequest, rejectRequest as rejectContactRequest, getPendingRequestCount } from "../request-queue.js";
import type { RequestStatus } from "../request-queue.js";
import { isAuthenticated } from "./auth.js";
import { respondJson, apiHandler, ApiError } from "../utils/api-helpers.js";

export function handleContactRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  // -- Whitelist Permissions --
  if (pathname === "/api/whitelist/permissions" && req.method === "PUT" && isAuthenticated(req)) {
    handleWhitelistPermissions(req, res);
    return true;
  }

  // -- Whitelist CRUD --
  if (pathname === "/api/whitelist" && isAuthenticated(req)) {
    if (req.method === "GET") {
      respondJson(res, 200, getWhitelist());
      return true;
    }
    if (req.method === "POST") {
      handleWhitelistAdd(req, res);
      return true;
    }
    if (req.method === "DELETE") {
      handleWhitelistRemove(req, res);
      return true;
    }
  }

  // -- Actionable Requests --
  if (pathname === "/api/actionable-requests" && req.method === "GET" && isAuthenticated(req)) {
    const statusFilter = url.searchParams.get("status") as ActionableRequestStatus | null;
    respondJson(res, 200, getActionableRequests(statusFilter || undefined));
    return true;
  }
  if (pathname === "/api/actionable-requests/pending-count" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, { count: getPendingCount() });
    return true;
  }
  if (req.method === "POST" && isAuthenticated(req)) {
    const approveMatch = pathname.match(/^\/api\/actionable-requests\/([^/]+)\/approve$/);
    if (approveMatch) {
      try {
        const result = approveRequest(approveMatch[1]);
        respondJson(res, 200, result);
      } catch (err) {
        respondJson(res, 400, { error: String(err) });
      }
      return true;
    }
    const rejectMatch = pathname.match(/^\/api\/actionable-requests\/([^/]+)\/reject$/);
    if (rejectMatch) {
      try {
        const result = rejectRequest(rejectMatch[1]);
        respondJson(res, 200, result);
      } catch (err) {
        respondJson(res, 400, { error: String(err) });
      }
      return true;
    }
  }

  // -- Directives --
  if (pathname === "/api/directives" && isAuthenticated(req)) {
    if (req.method === "GET") {
      const contactJid = url.searchParams.get("contactJid");
      respondJson(res, 200, contactJid ? getDirectivesForContact(contactJid) : getDirectives());
      return true;
    }
    if (req.method === "POST") {
      handleDirectiveAdd(req, res);
      return true;
    }
  }
  if (req.method === "PATCH" && isAuthenticated(req)) {
    const directiveMatch = pathname.match(/^\/api\/directives\/([^/]+)$/);
    if (directiveMatch) {
      handleDirectiveUpdate(req, res, directiveMatch[1]);
      return true;
    }
  }
  if (req.method === "DELETE" && isAuthenticated(req)) {
    const directiveDeleteMatch = pathname.match(/^\/api\/directives\/([^/]+)$/);
    if (directiveDeleteMatch) {
      const removed = removeDirective(directiveDeleteMatch[1]);
      respondJson(res, removed ? 200 : 404, { success: removed });
      return true;
    }
  }

  // -- Reply Directives --
  if (pathname === "/api/reply-directives" && isAuthenticated(req)) {
    if (req.method === "GET") {
      respondJson(res, 200, getReplyDirectives());
      return true;
    }
    if (req.method === "POST") {
      handleReplyDirectiveAdd(req, res);
      return true;
    }
  }
  if (pathname === "/api/reply-directives/log" && req.method === "GET" && isAuthenticated(req)) {
    const rdLogUrl = new URL(req.url || "/", `http://${req.headers.host}`);
    const rdLimit = parseInt(rdLogUrl.searchParams.get("limit") || "100", 10);
    const rdChatJid = rdLogUrl.searchParams.get("chatJid") || undefined;
    respondJson(res, 200, getReplyLog(rdLimit, rdChatJid));
    return true;
  }
  if (pathname === "/api/reply-directives/test" && req.method === "POST" && isAuthenticated(req)) {
    handleReplyDirectiveTest(req, res);
    return true;
  }
  if (req.method === "PATCH" && isAuthenticated(req)) {
    const rdPatchMatch = pathname.match(/^\/api\/reply-directives\/([^/]+)$/);
    if (rdPatchMatch) {
      handleReplyDirectiveUpdate(req, res, rdPatchMatch[1]);
      return true;
    }
  }
  if (req.method === "DELETE" && isAuthenticated(req)) {
    const rdDeleteMatch = pathname.match(/^\/api\/reply-directives\/([^/]+)$/);
    if (rdDeleteMatch) {
      const removed = removeReplyDirective(rdDeleteMatch[1]);
      respondJson(res, removed ? 200 : 400, { success: removed });
      return true;
    }
  }

  // -- Message Handlers --
  if (pathname === "/api/message-handlers" && isAuthenticated(req)) {
    if (req.method === "GET") {
      respondJson(res, 200, getHandlers());
      return true;
    }
    if (req.method === "POST") {
      handleMessageHandlerAdd(req, res);
      return true;
    }
  }
  if (pathname === "/api/message-handlers/log" && req.method === "GET" && isAuthenticated(req)) {
    const mhLogUrl = new URL(req.url || "/", `http://${req.headers.host}`);
    const mhLimit = parseInt(mhLogUrl.searchParams.get("limit") || "100", 10);
    const mhHandlerId = mhLogUrl.searchParams.get("handlerId") || undefined;
    respondJson(res, 200, getHandlerLog(mhLimit, mhHandlerId));
    return true;
  }
  if (pathname === "/api/message-handlers/stats" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getHandlerStats());
    return true;
  }
  if (pathname === "/api/message-handlers/flags" && req.method === "GET" && isAuthenticated(req)) {
    const flagUrl = new URL(req.url || "/", `http://${req.headers.host}`);
    const flagLimit = parseInt(flagUrl.searchParams.get("limit") || "50", 10);
    respondJson(res, 200, getHandlerFlags(flagLimit));
    return true;
  }
  if (pathname === "/api/message-handlers/test" && req.method === "POST" && isAuthenticated(req)) {
    handleMessageHandlerTest(req, res);
    return true;
  }
  if (req.method === "PATCH" && isAuthenticated(req)) {
    const mhPatchMatch = pathname.match(/^\/api\/message-handlers\/([^/]+)$/);
    if (mhPatchMatch) {
      handleMessageHandlerUpdate(req, res, mhPatchMatch[1]);
      return true;
    }
  }
  if (req.method === "DELETE" && isAuthenticated(req)) {
    const mhDeleteMatch = pathname.match(/^\/api\/message-handlers\/([^/]+)$/);
    if (mhDeleteMatch) {
      const removed = removeHandler(mhDeleteMatch[1]);
      respondJson(res, removed ? 200 : 400, { success: removed });
      return true;
    }
  }

  // -- Contact Request Queue --
  if (pathname === "/api/contact-requests" && req.method === "GET" && isAuthenticated(req)) {
    const statusFilter = url.searchParams.get("status") as RequestStatus | null;
    respondJson(res, 200, getContactRequests(statusFilter || undefined));
    return true;
  }
  if (pathname === "/api/contact-requests/pending-count" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, { count: getPendingRequestCount() });
    return true;
  }
  if (req.method === "POST" && isAuthenticated(req)) {
    const crApproveMatch = pathname.match(/^\/api\/contact-requests\/([^/]+)\/approve$/);
    if (crApproveMatch) {
      handleContactRequestApprove(req, res, crApproveMatch[1]);
      return true;
    }
    const crRejectMatch = pathname.match(/^\/api\/contact-requests\/([^/]+)\/reject$/);
    if (crRejectMatch) {
      handleContactRequestReject(req, res, crRejectMatch[1]);
      return true;
    }
  }

  // -- Contact sync (not wrapped -- uses setTimeout callback pattern) --
  if (pathname === "/api/sync-contacts" && req.method === "POST" && isAuthenticated(req)) {
    syncContacts()
      .then(() => {
        setTimeout(() => {
          const contacts = getAllContacts();
          respondJson(res, 200, { success: true, contactCount: contacts.length });
        }, 3000);
      })
      .catch((err) => {
        respondJson(res, 500, { error: String(err) });
      });
    return true;
  }

  // -- Contacts search --
  if (pathname === "/api/contacts" && isAuthenticated(req)) {
    const query = url.searchParams.get("q");
    const contacts = query ? findContacts(query) : getAllContacts();
    respondJson(res, 200, contacts);
    return true;
  }

  return false;
}

// -- Whitelist handlers --

const handleWhitelistAdd = apiHandler(async (_req, _res, body: { jid?: string; name?: string }) => {
  if (!body.jid || !body.name) throw new ApiError(400, "jid and name are required");
  addToWhitelist(body.jid, body.name);
  return { success: true };
});

const handleWhitelistRemove = apiHandler(async (_req, _res, body: { jid?: string }) => {
  if (!body.jid) throw new ApiError(400, "jid is required");
  return { success: removeFromWhitelist(body.jid) };
});

const handleWhitelistPermissions = apiHandler(async (_req, _res, body: { jid?: string; permissions?: ContactPermissions | null }) => {
  if (!body.jid) throw new ApiError(400, "jid is required");
  const ok = updatePermissions(body.jid, body.permissions ?? null);
  if (!ok) throw new ApiError(404, "Contact not found on whitelist");
  return { success: true };
});

// -- Directive handlers --

const handleDirectiveAdd = apiHandler(async (_req, _res, body: {
  contactJid?: string;
  contactName?: string;
  actionType?: string;
  policy?: string;
  note?: string;
}) => {
  if (!body.contactJid || !body.contactName || !body.actionType || !body.policy) {
    throw new ApiError(400, "contactJid, contactName, actionType, and policy are required");
  }
  return addDirective(
    body.contactJid,
    body.contactName,
    body.actionType as DirectiveActionType,
    body.policy as DirectivePolicy,
    body.note,
  );
});

function handleDirectiveUpdate(req: IncomingMessage, res: ServerResponse, id: string) {
  const handler = apiHandler(async (_req, _res, body: {
    policy?: DirectivePolicy;
    enabled?: boolean;
    note?: string;
  }) => {
    const result = updateDirective(id, body);
    if (!result) throw new ApiError(404, "Directive not found");
    return result;
  });
  handler(req, res);
}

// -- Reply directive handlers --

const handleReplyDirectiveAdd = apiHandler(async (_req, _res, body: {
  category?: string;
  contactJid?: string;
  contactName?: string;
  filterPrompt?: string;
  replyPrompt?: string;
  enabled?: boolean;
}) => {
  if (!body.filterPrompt || !body.replyPrompt) {
    throw new ApiError(400, "filterPrompt and replyPrompt are required");
  }
  if (!body.category && !body.contactJid) {
    throw new ApiError(400, "Either category or contactJid is required");
  }
  return addReplyDirective({
    category: body.category as ReplyCategory | undefined,
    contactJid: body.contactJid,
    contactName: body.contactName,
    filterPrompt: body.filterPrompt,
    replyPrompt: body.replyPrompt,
    enabled: body.enabled,
  });
});

function handleReplyDirectiveUpdate(req: IncomingMessage, res: ServerResponse, id: string) {
  const handler = apiHandler(async (_req, _res, body: {
    filterPrompt?: string;
    replyPrompt?: string;
    enabled?: boolean;
    contactName?: string;
  }) => {
    const result = updateReplyDirective(id, body);
    if (!result) throw new ApiError(404, "Reply directive not found");
    return result;
  });
  handler(req, res);
}

const handleReplyDirectiveTest = apiHandler(async (_req, _res, body: {
  directiveId?: string;
  testMessage?: string;
  senderName?: string;
  isGroup?: boolean;
  groupName?: string;
}) => {
  if (!body.directiveId || !body.testMessage || !body.senderName) {
    throw new ApiError(400, "directiveId, testMessage, and senderName are required");
  }
  return testReplyDirective({
    directiveId: body.directiveId,
    testMessage: body.testMessage,
    senderName: body.senderName,
    isGroup: body.isGroup ?? false,
    groupName: body.groupName,
  });
});

// -- Contact request handlers --

function handleContactRequestApprove(req: IncomingMessage, res: ServerResponse, id: string) {
  const handler = apiHandler(async (_req, _res, body: { note?: string }) => {
    return approveContactRequest(id, body?.note);
  });
  handler(req, res);
}

function handleContactRequestReject(req: IncomingMessage, res: ServerResponse, id: string) {
  const handler = apiHandler(async (_req, _res, body: { note?: string }) => {
    return rejectContactRequest(id, body?.note);
  });
  handler(req, res);
}

// -- Message handler handlers --

function handleMessageHandlerAdd(req: IncomingMessage, res: ServerResponse) {
  const handler = apiHandler(async (_req, _res, body: {
    name: string;
    description?: string;
    scope: HandlerScope;
    gate?: HandlerGate;
    filterPrompt: string;
    action: HandlerAction;
    cooldownMs?: number;
    maxLLMCallsPerDay?: number;
    enabled?: boolean;
  }) => {
    if (!body.name || !body.filterPrompt || !body.action?.type) {
      throw new ApiError(400, "name, filterPrompt, and action.type are required");
    }
    return addHandler(body);
  });
  handler(req, res);
}

function handleMessageHandlerUpdate(req: IncomingMessage, res: ServerResponse, id: string) {
  const handler = apiHandler(async (_req, _res, body: Record<string, unknown>) => {
    const result = updateHandler(id, body);
    if (!result) throw new ApiError(404, "Handler not found");
    return result;
  });
  handler(req, res);
}

function handleMessageHandlerTest(req: IncomingMessage, res: ServerResponse) {
  const handler = apiHandler(async (_req, _res, body: {
    handlerId: string;
    testMessage: string;
    senderName: string;
    isGroup: boolean;
    groupName?: string;
  }) => {
    if (!body.handlerId || !body.testMessage) {
      throw new ApiError(400, "handlerId and testMessage are required");
    }
    return testHandler(body);
  });
  handler(req, res);
}
