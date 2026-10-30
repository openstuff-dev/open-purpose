// OpenPurpose site: progressive enhancement only. The page works without this file.
(() => {
  const cards = document.querySelectorAll(".card");

  // Pointer glow follows the pointer inside the hovered card.
  cards.forEach((card) => {
    card.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
  });

  // Touch: a tap on a card plays its illustration; a tap elsewhere settles it again.
  document.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "touch") return;
    const hit = e.target.closest(".card");
    cards.forEach((c) => {
      if (c !== hit) c.classList.remove("is-playing");
    });
    if (hit && !e.target.closest("a, button")) hit.classList.toggle("is-playing");
  });

  // Copy buttons: copy the text of the <code> they point at.
  const live = document.getElementById("copy-status");
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const src = document.getElementById(btn.dataset.copy);
      if (!src) return;
      const text = src.innerText.replace(/^\$ /gm, "").trim();
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = Object.assign(document.createElement("textarea"), { value: text });
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.append(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      const label = btn.querySelector("span");
      const before = label.textContent;
      btn.setAttribute("data-copied", "");
      label.textContent = "Copied";
      if (live) live.textContent = "Copied to clipboard";
      setTimeout(() => {
        btn.removeAttribute("data-copied");
        label.textContent = before;
        if (live) live.textContent = "";
      }, 1600);
    });
  });

  // Close the mobile menu after choosing a link.
  const menu = document.getElementById("menu");
  if (menu && menu.hidePopover) {
    menu.addEventListener("click", (e) => {
      if (e.target.closest("a")) menu.hidePopover();
    });
  }
})();
