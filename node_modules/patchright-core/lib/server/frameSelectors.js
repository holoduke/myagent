"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var frameSelectors_exports = {};
__export(frameSelectors_exports, {
  FrameSelectors: () => FrameSelectors
});
module.exports = __toCommonJS(frameSelectors_exports);
var import_utils = require("../utils");
var import_selectorParser = require("../utils/isomorphic/selectorParser");
var import_dom = require("./dom");
class FrameSelectors {
  constructor(frame) {
    this.frame = frame;
  }
  _parseSelector(selector, options) {
    const strict = typeof options?.strict === "boolean" ? options.strict : !!this.frame._page.browserContext._options.strictSelectors;
    return this.frame._page.browserContext.selectors().parseSelector(selector, strict);
  }
  async query(selector, options, scope) {
    const resolved = await this.resolveInjectedForSelector(selector, options, scope);
    if (!resolved)
      return null;
    const handle = await resolved.injected.evaluateHandle((injected, { info, scope: scope2 }) => {
      return injected.querySelector(info.parsed, scope2 || document, info.strict);
    }, { info: resolved.info, scope: resolved.scope });
    const elementHandle = handle.asElement();
    if (!elementHandle) {
      handle.dispose();
      return null;
    }
    return adoptIfNeeded(elementHandle, await resolved.frame._mainContext());
  }
  async queryArrayInMainWorld(selector, scope, isolatedContext) {
    const resolved = await this.resolveInjectedForSelector(selector, { mainWorld: !isolatedContext }, scope);
    if (!resolved)
      throw new Error(`Failed to find frame for selector "${selector}"`);
    return await resolved.injected.evaluateHandle((injected, { info, scope: scope2 }) => {
      const elements = injected.querySelectorAll(info.parsed, scope2 || document);
      injected.checkDeprecatedSelectorUsage(info.parsed, elements);
      return elements;
    }, { info: resolved.info, scope: resolved.scope });
  }
  async queryCount(selector, options) {
    const resolved = await this.resolveInjectedForSelector(selector);
    if (!resolved)
      throw new Error(`Failed to find frame for selector "${selector}"`);
    await options.__testHookBeforeQuery?.();
    return await resolved.injected.evaluate((injected, { info }) => {
      const elements = injected.querySelectorAll(info.parsed, document);
      injected.checkDeprecatedSelectorUsage(info.parsed, elements);
      return elements.length;
    }, { info: resolved.info });
  }
  async queryAll(selector, scope) {
    const resolved = await this.resolveInjectedForSelector(selector, {}, scope);
    if (!resolved)
      return [];
    const arrayHandle = await resolved.injected.evaluateHandle((injected, { info, scope: scope2 }) => {
      const elements = injected.querySelectorAll(info.parsed, scope2 || document);
      injected.checkDeprecatedSelectorUsage(info.parsed, elements);
      return elements;
    }, { info: resolved.info, scope: resolved.scope });
    const properties = await arrayHandle.getProperties();
    arrayHandle.dispose();
    const targetContext = await resolved.frame._mainContext();
    const result = [];
    for (const property of properties.values()) {
      const elementHandle = property.asElement();
      if (elementHandle)
        result.push(adoptIfNeeded(elementHandle, targetContext));
      else
        property.dispose();
    }
    return Promise.all(result);
  }
  _jumpToAriaRefFrameIfNeeded(selector, info, frame) {
    if (info.parsed.parts[0].name !== "aria-ref")
      return frame;
    const body = info.parsed.parts[0].body;
    const match = body.match(/^f(\d+)e\d+$/);
    if (!match)
      return frame;
    const frameSeq = +match[1];
    const jumptToFrame = this.frame._page.frameManager.frames().find((frame2) => frame2.seq === frameSeq);
    if (!jumptToFrame)
      throw new import_selectorParser.InvalidSelectorError(`Invalid frame in aria-ref selector "${selector}"`);
    return jumptToFrame;
  }
  async resolveFrameForSelector(selector, options = {}, scope) {
    let frame = this.frame;
    const frameChunks = (0, import_selectorParser.splitSelectorByFrame)(selector);
    for (const chunk of frameChunks) {
      (0, import_selectorParser.visitAllSelectorParts)(chunk, (part, nested) => {
        if (nested && part.name === "internal:control" && part.body === "enter-frame") {
          const locator = (0, import_utils.asLocator)(this.frame._page.browserContext._browser.sdkLanguage(), selector);
          throw new import_selectorParser.InvalidSelectorError(`Frame locators are not allowed inside composite locators, while querying "${locator}"`);
        }
      });
    }
    for (let i = 0; i < frameChunks.length - 1; ++i) {
      const info = this._parseSelector(frameChunks[i], options);
      frame = this._jumpToAriaRefFrameIfNeeded(selector, info, frame);
      const context = await frame._context(info.world);
      const injectedScript = await context.injectedScript();
      const handle = await injectedScript.evaluateHandle((injected, { info: info2, scope: scope2, selectorString }) => {
        const element2 = injected.querySelector(info2.parsed, scope2 || document, info2.strict);
        if (element2 && element2.nodeName !== "IFRAME" && element2.nodeName !== "FRAME")
          throw injected.createStacklessError(`Selector "${selectorString}" resolved to ${injected.previewNode(element2)}, <iframe> was expected`);
        return element2;
      }, { info, scope: i === 0 ? scope : void 0, selectorString: (0, import_selectorParser.stringifySelector)(info.parsed) });
      let element = handle.asElement();
      if (!element) {
        try {
          var client = frame._page.delegate._sessionForFrame(frame)._client;
        } catch (e) {
          var client = frame._page.delegate._mainFrameSession._client;
        }
        var mainContext = await frame._context("main");
        const documentNode = await client.send("Runtime.evaluate", {
          expression: "document",
          serializationOptions: { serialization: "idOnly" },
          contextId: mainContext.delegate._contextId
        });
        const documentScope = new import_dom.ElementHandle(mainContext, documentNode.result.objectId);
        var check = await this._customFindFramesByParsed(injectedScript, client, mainContext, documentScope, void 0, info.parsed);
        if (check.length === 0) return null;
        element = check[0];
      }
      const maybeFrame = await frame._page.delegate.getContentFrame(element);
      element.dispose();
      if (!maybeFrame)
        return null;
      frame = maybeFrame;
    }
    if (frame !== this.frame)
      scope = void 0;
    const lastChunk = frame.selectors._parseSelector(frameChunks[frameChunks.length - 1], options);
    frame = this._jumpToAriaRefFrameIfNeeded(selector, lastChunk, frame);
    return { frame, info: lastChunk, scope };
  }
  async resolveInjectedForSelector(selector, options, scope) {
    const resolved = await this.resolveFrameForSelector(selector, options, scope);
    if (!resolved)
      return;
    const context = await resolved.frame._context(options?.mainWorld ? "main" : resolved.info.world);
    if (!context) throw new Error("Frame was detached");
    const injected = await context.injectedScript();
    return { injected, info: resolved.info, frame: resolved.frame, scope: resolved.scope };
  }
  async _customFindFramesByParsed(resolved, client, context, documentScope, progress, parsed) {
    var parsedEdits = { ...parsed };
    const callId = progress?.metadata.id;
    var currentScopingElements = [documentScope];
    for (const part of [...parsed.parts]) {
      parsedEdits.parts = [part];
      var elements = [];
      if (part.name === "nth") {
        const partNth = Number(part.body);
        if (currentScopingElements.length == 0)
          return [];
        if (partNth > currentScopingElements.length - 1 || partNth < -(currentScopingElements.length - 1)) {
          if (parsed.capture !== void 0)
            throw new Error("Can't query n-th element in a request with the capture.");
          return [];
        }
        currentScopingElements = [currentScopingElements.at(partNth)];
        continue;
      } else if (part.name === "internal:or") {
        var orredElements = await this._customFindFramesByParsed(resolved, client, context, documentScope, progress, part.body.parsed);
        elements = [...currentScopingElements, ...orredElements];
      } else if (part.name == "internal:and") {
        var andedElements = await this._customFindFramesByParsed(resolved, client, context, documentScope, progress, part.body.parsed);
        const backendNodeIds = new Set(andedElements.map((elem) => elem.backendNodeId));
        elements = currentScopingElements.filter((elem) => backendNodeIds.has(elem.backendNodeId));
      } else {
        for (const scope of currentScopingElements) {
          const describedScope = await client.send("DOM.describeNode", {
            objectId: scope._objectId,
            depth: -1,
            pierce: true
          });
          let findClosedShadowRoots = function(node, results = []) {
            if (!node || typeof node !== "object") return results;
            if (node.shadowRoots && Array.isArray(node.shadowRoots)) {
              for (const shadowRoot2 of node.shadowRoots) {
                if (shadowRoot2.shadowRootType === "closed" && shadowRoot2.backendNodeId) {
                  results.push(shadowRoot2.backendNodeId);
                }
                findClosedShadowRoots(shadowRoot2, results);
              }
            }
            if (node.nodeName !== "IFRAME" && node.children && Array.isArray(node.children)) {
              for (const child of node.children) {
                findClosedShadowRoots(child, results);
              }
            }
            return results;
          };
          var shadowRootBackendIds = findClosedShadowRoots(describedScope.node);
          const shadowRoots = await Promise.all(
            shadowRootBackendIds.map(async (backendNodeId) => {
              const resolved2 = await client.send("DOM.resolveNode", {
                backendNodeId,
                contextId: context.delegate._contextId
              });
              return new import_dom.ElementHandle(context, resolved2.object.objectId);
            })
          );
          const queryGroups = [];
          for (var shadowRoot of shadowRoots) {
            const shadowHandles = await shadowRoot.evaluateHandleInUtility(
              ([injected, node, { parsed: parsed2, callId: callId2 }]) => {
                const elements2 = injected.querySelectorAll(parsed2, node);
                if (callId2)
                  injected.markTargetElements(new Set(elements2), callId2);
                return elements2;
              },
              {
                parsed: parsedEdits,
                callId
              }
            );
            queryGroups.push({ handles: shadowHandles, parentNode: shadowRoot });
          }
          const rootHandles = await scope.evaluateHandleInUtility(
            ([injected, node, { parsed: parsed2, callId: callId2 }]) => {
              const elements2 = injected.querySelectorAll(parsed2, node);
              if (callId2)
                injected.markTargetElements(new Set(elements2), callId2);
              return elements2;
            },
            {
              parsed: parsedEdits,
              callId
            }
          );
          queryGroups.push({ handles: rootHandles, parentNode: scope });
          for (const { handles, parentNode } of queryGroups) {
            const handlesAmount = await (await handles.getProperty("length")).jsonValue();
            for (var i = 0; i < handlesAmount; i++) {
              if (parentNode instanceof import_dom.ElementHandle) {
                var element = await parentNode.evaluateHandleInUtility(
                  ([injected, node, { i: i2, handles: elems }]) => elems[i2],
                  { i, handles }
                );
              } else {
                var element = await parentNode.evaluateHandle(
                  (injected, { i: i2, handles: elems }) => elems[i2],
                  { i, handles }
                );
              }
              element.parentNode = parentNode;
              const resolvedElement = await client.send("DOM.describeNode", { objectId: element._objectId, depth: -1 });
              element.backendNodeId = resolvedElement.node.backendNodeId;
              element.nodePosition = await this._findElementPositionInDomTree(element, describedScope.node, context, "");
              elements.push(element);
            }
          }
        }
      }
      const getParts = (pos) => (pos || "").split(".").filter(Boolean).map(Number);
      elements.sort((a, b) => {
        const partsA = getParts(a.nodePosition);
        const partsB = getParts(b.nodePosition);
        for (let i2 = 0; i2 < Math.max(partsA.length, partsB.length); i2++) {
          const diff = (partsA[i2] ?? -1) - (partsB[i2] ?? -1);
          if (diff !== 0) return diff;
        }
        return 0;
      });
      currentScopingElements = Array.from(
        new Map(elements.map((e) => [e.backendNodeId, e])).values()
      );
    }
    return currentScopingElements;
  }
  async _findElementPositionInDomTree(element, queryingElement, context, currentIndex) {
    if (element.backendNodeId === queryingElement.backendNodeId)
      return currentIndex;
    for (const [childrenNodeIndex, child] of (queryingElement.children || []).entries()) {
      const childIndex = await this._findElementPositionInDomTree(element, child, context, currentIndex + "." + childrenNodeIndex.toString());
      if (childIndex !== null) return childIndex;
    }
    for (const shadowRoot of queryingElement.shadowRoots || []) {
      if (shadowRoot.shadowRootType === "closed" && shadowRoot.backendNodeId) {
        const client = context.frame._page.delegate._sessionForFrame(context.frame)._client;
        const describedShadowRoot = await client.send("DOM.describeNode", { backendNodeId: shadowRoot.backendNodeId, depth: -1, pierce: true });
        if (describedShadowRoot && describedShadowRoot.node) {
          const childIndex = await this._findElementPositionInDomTree(element, describedShadowRoot.node, context, currentIndex);
          if (childIndex !== null) return childIndex;
        }
      }
      for (const [shadowChildIndex, shadowChild] of (shadowRoot.children || []).entries()) {
        const childIndex = await this._findElementPositionInDomTree(element, shadowChild, context, currentIndex + "." + shadowChildIndex.toString());
        if (childIndex !== null) return childIndex;
      }
    }
    return null;
  }
}
async function adoptIfNeeded(handle, context) {
  if (handle._context === context)
    return handle;
  const adopted = await handle._page.delegate.adoptElementHandle(handle, context);
  handle.dispose();
  return adopted;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FrameSelectors
});
