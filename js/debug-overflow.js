export function installOverflowDebug() {
  if (new URLSearchParams(window.location.search).get("debug") !== "1") return;

  const badge = document.createElement("button");
  badge.className = "overflow-debug-badge";
  badge.type = "button";
  badge.setAttribute("aria-label", "Rescan visible layout for overflow");
  document.body.append(badge);
  let scheduled = false;
  let lastSignature = null;

  function getVisibleBounds(element) {
    const bounds = element.getBoundingClientRect();
    const visible = {
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom
    };
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor);
      const clipX = style.overflowX !== "visible";
      const clipY = style.overflowY !== "visible";
      if (!clipX && !clipY) continue;
      const clip = ancestor.getBoundingClientRect();
      if (clipX) {
        visible.left = Math.max(visible.left, clip.left);
        visible.right = Math.min(visible.right, clip.right);
      }
      if (clipY) {
        visible.top = Math.max(visible.top, clip.top);
        visible.bottom = Math.min(visible.bottom, clip.bottom);
      }
      if (visible.right <= visible.left || visible.bottom <= visible.top) return null;
    }
    return visible;
  }

  function scan() {
    scheduled = false;
    for (const element of document.querySelectorAll(".overflow-debug-outline")) {
      element.classList.remove("overflow-debug-outline");
    }

    const findings = [];
    for (const element of document.querySelectorAll("body *")) {
      if (element === badge || element.matches("script, style, link, meta")) continue;
      const closedDetails = element.closest("details:not([open])");
      if (closedDetails && !element.closest("summary")) continue;
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const visibleBounds = getVisibleBounds(element);
      if (!visibleBounds) continue;

      const horizontalOverflow = element.scrollWidth > element.clientWidth + 1;
      const outsideViewport = visibleBounds.left < -1 ||
        visibleBounds.top < -1 ||
        visibleBounds.right > window.innerWidth + 1 ||
        visibleBounds.bottom > window.innerHeight + 1;
      if (!horizontalOverflow && !outsideViewport) continue;

      element.classList.add("overflow-debug-outline");
      findings.push({
        element,
        horizontalOverflow,
        outsideViewport,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        bounds: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom)
        }
      });
    }

    badge.textContent = `UI: ${findings.length}`;
    badge.title = findings.length
      ? `${findings.length} visible overflow item${findings.length === 1 ? "" : "s"}; tap to rescan`
      : "No visible overflow found; tap to rescan";
    const signature = findings.map((item) => {
      const element = item.element;
      return `${element.id || element.className || element.tagName}:${item.horizontalOverflow}:${item.outsideViewport}`;
    }).join("|");
    if (signature !== lastSignature) {
      lastSignature = signature;
      if (findings.length) console.warn("Visible UI overflow findings:", findings);
      else console.info("No visible UI overflow found.");
    }
  }

  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(scan, 180);
  }

  badge.addEventListener("click", scan);
  window.addEventListener("resize", scheduleScan);
  window.addEventListener("orientationchange", scheduleScan);
  document.addEventListener("click", scheduleScan, true);
  document.addEventListener("toggle", scheduleScan, true);
  document.addEventListener("input", scheduleScan, true);
  new MutationObserver((records) => {
    if (records.every((record) => record.target === badge || badge.contains(record.target))) return;
    scheduleScan();
  }).observe(document.body, {
    childList: true,
    subtree: true
  });
  scheduleScan();
}
