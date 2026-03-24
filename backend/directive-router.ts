/**
 * Routes actionable observations through the directive system.
 *
 * Maps ActionableCategory signals to DirectiveActionType and enqueues
 * requests in the request queue with the appropriate policy.
 */

import { createLogger } from "./logger.js";
import { enqueueRequest } from "./request-queue.js";
import type { DirectiveActionType } from "./directives.js";
import type { ActionableCategory } from "./actionable.js";
import type { Observation } from "./observer.js";

const log = createLogger("directive-router");

/** Map actionable categories to directive action types */
const CATEGORY_TO_ACTION_TYPE: Record<ActionableCategory, DirectiveActionType> = {
  event: "calendar",
  invitation: "calendar",
  logistics: "logistics",
  request: "task",
  deadline: "reminder",
  action_item: "reminder",
};

/**
 * Route an observation with actionable signals through the directive system.
 * Creates request-queue entries based on the directive policy for each signal.
 */
export function routeObservationToDirectives(obs: Observation): void {
  if (!obs.actionableSignals || obs.actionableSignals.length === 0) return;

  // Deduplicate by action type — one request per action type per message
  const seenActionTypes = new Set<DirectiveActionType>();

  for (const signal of obs.actionableSignals) {
    const actionType = CATEGORY_TO_ACTION_TYPE[signal.category];
    if (!actionType || seenActionTypes.has(actionType)) continue;
    seenActionTypes.add(actionType);

    try {
      enqueueRequest({
        contactJid: obs.senderJid,
        contactName: obs.sender,
        message: obs.text,
        actionType,
        actionSummary: signal.snippet,
        isGroup: obs.isGroup,
        groupName: obs.groupName,
      });
    } catch (err) {
      log(`Failed to enqueue request from ${obs.sender}: ${err}`);
    }
  }
}
