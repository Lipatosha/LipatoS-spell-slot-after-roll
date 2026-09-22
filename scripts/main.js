const MODULE_ID = "lipatos-spell-slot-after-roll";

const isPlayer = () => !!game.user && !game.user.isGM;
const text = el => (el?.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();

function getRoot(app, html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  if (app?.element instanceof HTMLElement) return app.element;
  if (app?.element?.[0] instanceof HTMLElement) return app.element[0];
  return null;
}

function hide(el) {
  if (!el) return;
  el.style.setProperty("display", "none", "important");
}

function patchSpellUseDialog(root) {
  if (!root || !isPlayer()) return;

  for (const el of root.querySelectorAll("label,legend,h3,h4,span,p,div")) {
    const t = text(el);
    if (!/использовать ячейку|use spell slot|consume spell slot/.test(t)) continue;

    const group = el.closest("fieldset,.form-group,.form-fields,.card,.field,.flexrow") ?? el.parentElement;
    const checkbox = group?.querySelector('input[type="checkbox"]');
    if (checkbox && !checkbox.checked) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  for (const el of root.querySelectorAll("legend,h3,h4,label,span,p")) {
    const t = text(el);
    if (t !== "расход" && t !== "consumption") continue;

    const section = el.closest("fieldset,.form-group,.card") ?? el.parentElement;
    if (section) hide(section);
  }
}

function patchApp(app, html) {
  if (!isPlayer()) return;
  const root = getRoot(app, html);
  if (!root) return;

  const run = () => patchSpellUseDialog(root);
  run();

  if (!root._lipatosSpellAfterRollObserver) {
    const observer = new MutationObserver(() => queueMicrotask(run));
    observer.observe(root, { childList: true, subtree: true });
    root._lipatosSpellAfterRollObserver = observer;
  }
}

Hooks.on("renderApplicationV2", patchApp);
Hooks.on("renderActivityUseDialog", patchApp);

const pending = new Map();

function activityKey(activity) {
  return `${activity?.actor?.uuid ?? ""}:${activity?.item?.id ?? ""}:${activity?.id ?? ""}`;
}

function snapshotSpellSlots(activity) {
  const actor = activity?.actor;
  if (!actor) return null;
  return {
    actor,
    spells: foundry.utils.deepClone(actor.system?.spells ?? {})
  };
}

function spellSlotsChanged(before, after) {
  if (!before || !after) return false;
  return JSON.stringify(before.spells) !== JSON.stringify(after.spells);
}

async function applySnapshot(snapshot) {
  if (!snapshot?.actor) return;

  const update = {};
  for (const [slot, data] of Object.entries(snapshot.spells ?? {})) {
    if (data && Object.prototype.hasOwnProperty.call(data, "value")) {
      update[`system.spells.${slot}.value`] = data.value;
    }
  }

  if (Object.keys(update).length) {
    await snapshot.actor.update(update, {
      [MODULE_ID]: { deferredSpellSlot: true }
    });
  }
}

Hooks.on("dnd5e.preActivityConsumption", activity => {
  if (!isPlayer() || activity?.actor?.type !== "character") return;
  activity._lipatosSpellSlotBefore = snapshotSpellSlots(activity);
});

Hooks.on("dnd5e.postActivityConsumption", async activity => {
  if (!isPlayer() || activity?.actor?.type !== "character") return;

  const before = activity._lipatosSpellSlotBefore;
  delete activity._lipatosSpellSlotBefore;
  if (!before) return;

  const after = snapshotSpellSlots(activity);
  if (!spellSlotsChanged(before, after)) return;

  pending.set(activityKey(activity), {
    before,
    after,
    createdAt: Date.now()
  });

  await applySnapshot(before);
});

async function commitAfterRoll(subject) {
  if (!isPlayer() || !subject) return;

  const key = activityKey(subject);
  const state = pending.get(key);
  if (!state) return;

  pending.delete(key);
  await applySnapshot(state.after);
}

for (const hook of [
  "dnd5e.rollAttack",
  "dnd5e.rollAttackV2",
  "dnd5e.rollDamage",
  "dnd5e.rollDamageV2"
]) {
  Hooks.on(hook, async (rolls, data) => {
    if (rolls?.length) await commitAfterRoll(data?.subject);
  });
}

Hooks.on("dnd5e.postRollConfiguration", async (rolls, config) => {
  if (rolls?.length && config?.subject) {
    await commitAfterRoll(config.subject);
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [key, state] of pending) {
    if (now - state.createdAt > 10 * 60 * 1000) pending.delete(key);
  }
}, 60 * 1000);

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready`);
});
