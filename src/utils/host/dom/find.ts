import type { Point } from "@/types/dom"

import { getLocalConfig } from "@/utils/config/storage"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { CONTENT_WRAPPER_CLASS } from "@/utils/constants/dom-labels"
import { isDontWalkIntoAndDontTranslateAsChildElement, isHTMLElement, isShallowInlineHTMLElement, isTranslatedContentNode, isTranslatedWrapperNode } from "./filter"
import { smashTruncationStyle } from "./style"

/**
 * Find the deepest element at the given point, including inside shadow roots
 * @param root - The root element (Document or ShadowRoot)
 * @param point - The point to find the deepest element
 */
function findElementAt(root: Document | ShadowRoot, point: Point): Element | null {
  const { x, y } = point

  // First, try to get the element at the point from the root
  const initialElement = root.elementFromPoint(x, y)
  if (!initialElement) {
    return null
  }

  // If the initial element has a shadow root, check if the point is actually inside the shadow content
  if (initialElement.shadowRoot) {
    const shadowElement = findElementAt(initialElement.shadowRoot, point)
    if (shadowElement) {
      return shadowElement
    }
  }

  // Find the deepest element by traversing children
  function findDeepestElement(element: Element): Element {
    let deepestElement = element

    for (const child of element.children) {
      if (isHTMLElement(child)) {
        const rect = child.getBoundingClientRect()
        const isPointInChild = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom

        if (isPointInChild) {
          // If child has shadow root, recursively search within it
          if (child.shadowRoot) {
            const shadowResult = findElementAt(child.shadowRoot, point)
            if (shadowResult) {
              return shadowResult
            }
          }

          // Continue searching deeper in this child
          deepestElement = findDeepestElement(child)
          if (deepestElement.textContent?.trim())
            return deepestElement
        }
      }
    }

    return deepestElement
  }

  return findDeepestElement(initialElement)
}

function isTextNode(node: Node | null): node is Text {
  return node?.nodeType === Node.TEXT_NODE
}

function isPointInsideRect(point: Point, rect: DOMRect | DOMRectReadOnly): boolean {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
}

function isPointInsideTextRange(point: Point, node: Text, startOffset: number, endOffset: number): boolean {
  if (!node.textContent?.slice(startOffset, endOffset).trim())
    return false

  const range = document.createRange()
  range.setStart(node, startOffset)
  range.setEnd(node, endOffset)

  if (typeof range.getClientRects !== "function")
    return false

  for (const rect of range.getClientRects()) {
    if (isPointInsideRect(point, rect))
      return true
  }

  return false
}

function findCaretTextNodeAtPoint(point: Point): Text | null {
  const documentWithCaretPosition = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node, offset: number } | null
  }
  const caretPosition = documentWithCaretPosition.caretPositionFromPoint?.(point.x, point.y)
  if (caretPosition && isTextNode(caretPosition.offsetNode)) {
    const text = caretPosition.offsetNode.textContent ?? ""
    const offsets = [
      caretPosition.offset,
      caretPosition.offset - 1,
    ].filter(offset => offset >= 0 && offset < text.length)

    for (const offset of offsets) {
      if (isPointInsideTextRange(point, caretPosition.offsetNode, offset, offset + 1))
        return caretPosition.offsetNode
    }
  }

  return null
}

function findTextNodeByRangeRectsAtPoint(point: Point): Text | null {
  const element = findElementAt(document, point)
  if (!element)
    return null

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let currentNode = walker.nextNode()

  while (currentNode) {
    if (isTextNode(currentNode)) {
      const text = currentNode.textContent ?? ""
      for (let offset = 0; offset < text.length; offset++) {
        if (isPointInsideTextRange(point, currentNode, offset, offset + 1))
          return currentNode
      }
    }

    currentNode = walker.nextNode()
  }

  return null
}

/**
 * Returns true only when the viewport point is over rendered text.
 *
 * Element-level hit testing is not enough for node translation: blank areas of
 * large containers such as body/main can otherwise resolve to a block node and
 * translate the whole page. Text range rects keep the trigger tied to actual
 * glyph boxes.
 */
export function isPointOverText(point: Point): boolean {
  return findCaretTextNodeAtPoint(point) !== null || findTextNodeByRangeRectsAtPoint(point) !== null
}

export function findNearestAncestorBlockNodeFor(element: Element) {
  const startElement = element.closest(`.${CONTENT_WRAPPER_CLASS}`)?.parentElement || element
  let currentNode = startElement
  while (currentNode && currentNode.parentElement && isHTMLElement(currentNode) && isShallowInlineHTMLElement(currentNode)) {
    currentNode = currentNode.parentElement
  }
  return currentNode
}

/**
 * Find the nearest block node from the point
 * @param point - The point to find the nearest block node
 */
export function findNearestAncestorBlockNodeAt(point: Point) {
  const currentNode = findElementAt(document, point)
  if (!currentNode)
    return null

  return findNearestAncestorBlockNodeFor(currentNode)
}

export function deepQueryTopLevelSelector(element: HTMLElement | ShadowRoot | Document, selectorFn: (element: HTMLElement) => boolean): HTMLElement[] {
  if (element instanceof Document) {
    return deepQueryTopLevelSelector(element.body, selectorFn)
  }

  const result: HTMLElement[] = []
  if (element instanceof ShadowRoot) {
    for (const child of element.children) {
      if (isHTMLElement(child)) {
        result.push(...deepQueryTopLevelSelector(child, selectorFn))
      }
    }
    return result
  }

  if (selectorFn(element)) {
    return [element]
  }

  if (element.shadowRoot) {
    for (const child of element.shadowRoot.children) {
      if (isHTMLElement(child)) {
        result.push(...deepQueryTopLevelSelector(child, selectorFn))
      }
    }
  }

  for (const child of element.children) {
    if (isHTMLElement(child)) {
      result.push(...deepQueryTopLevelSelector(child, selectorFn))
    }
  }

  return result
}

export async function unwrapDeepestOnlyHTMLChild(element: HTMLElement) {
  const config = await getLocalConfig() ?? DEFAULT_CONFIG
  let currentElement = element
  while (currentElement) {
    smashTruncationStyle(currentElement)

    const shouldKeepNode = (child: ChildNode) => {
      if (!child.textContent?.trim())
        return false
      if (child.nodeType === Node.TEXT_NODE)
        return true
      return isHTMLElement(child) && !isDontWalkIntoAndDontTranslateAsChildElement(child, config)
    }

    const effectiveChildNodes = [...currentElement.childNodes].filter(shouldKeepNode)
    const effectiveChildren = effectiveChildNodes.filter(child => child.nodeType === Node.ELEMENT_NODE)

    // Only have one HTML child and no Text Child
    if (!(effectiveChildren.length === 1 && effectiveChildNodes.length === 1))
      break

    const onlyChildElement = effectiveChildren[0]
    if (!isHTMLElement(onlyChildElement))
      break

    currentElement = onlyChildElement
  }

  return currentElement
}

/**
 * Find the nearest translated content wrapper ancestor
 * @param node - The node should be a translated content node
 */
export function findTranslatedContentWrapper(node: HTMLElement): HTMLElement | null {
  if (!isTranslatedContentNode(node))
    return null

  let currentElement = node.parentElement
  while (currentElement) {
    if (isTranslatedWrapperNode(currentElement)) {
      return currentElement
    }
    currentElement = currentElement.parentElement
  }
  return null
}
