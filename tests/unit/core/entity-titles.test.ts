import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import { ToolRegistry } from "@/core/agents/tools";
import { createAccountInput, createCategoryInput } from "@/core/capabilities/finance";
import { createGoalInput, createVisionInput, updateGoalInput } from "@/core/capabilities/goals";
import { createHabitInput, updateHabitInput } from "@/core/capabilities/habits";
import {
  addItemsInput,
  createListInput,
  renameListInput,
  updateItemInput,
} from "@/core/capabilities/lists";
import { createTaskInput, createTaskListInput, updateTaskInput } from "@/core/capabilities/tasks";
import { normalizeEntityTitle } from "@/core/text";
import { LIST_TOOLS } from "@/core/tools/lists";
import { TASK_TOOLS } from "@/core/tools/tasks";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

/**
 * Names and titles arrive as people (or a transcript) said them; they are stored in sentence case
 * — "huevos" → "Huevos" — never Title Case, and never at the cost of what the user typed on
 * purpose ("iPhone", "RSFA", "make.com").
 */

describe("normalizeEntityTitle", () => {
  it.each([
    ["huevos", "Huevos"],
    ["comprar huevos para la semana", "Comprar huevos para la semana"],
    ["recargar chip mamá/Félix", "Recargar chip mamá/Félix"],
    ["RSFA GHI 03 Long Video", "RSFA GHI 03 Long Video"],
    ["crear bot con ChatGPT", "Crear bot con ChatGPT"],
    ["iPhone nuevo", "iPhone nuevo"],
    ["eLearning", "eLearning"],
    ["eBay", "eBay"],
    ["make.com", "make.com"],
    ["Firbot Solutions", "Firbot Solutions"],
    ["🛍️ comprar leche", "🛍️ Comprar leche"],
    ["  llamar a Marco  ", "Llamar a Marco"],
    ["llamar   a  Marco", "Llamar a Marco"],
    ["3 huevos", "3 huevos"],
    ["¿llamar a Marco?", "¿Llamar a Marco?"],
    ["élite", "Élite"],
    ["Comprar huevos", "Comprar huevos"],
    ["🎉", "🎉"],
  ])("%j → %j", (input, expected) => {
    expect(normalizeEntityTitle(input)).toBe(expected);
  });

  it("never lower-cases anything", () => {
    expect(normalizeEntityTitle("comprar PAN y LECHE")).toBe("Comprar PAN y LECHE");
  });
});

describe("every entity name is stored normalized", () => {
  it("lists: list names and items; the list reference stays as said", () => {
    const added = addItemsInput.parse({
      list: "compras",
      items: ["huevos", { content: "café molido", notes: "el de siempre" }],
    });
    expect(added.list).toBe("compras");
    expect(added.items).toEqual(["Huevos", { content: "Café molido", notes: "el de siempre" }]);
    expect(createListInput.parse({ name: "viaje a córdoba", items: ["cargador"] })).toMatchObject({
      name: "Viaje a córdoba",
      items: ["Cargador"],
    });
    expect(renameListInput.parse({ list: "compras", name: "súper" }).name).toBe("Súper");
    // The item to edit is found by what the user said; only the new text is normalized.
    expect(
      updateItemInput.parse({ list: "compras", item: "huevos", content: "huevos de campo" }),
    ).toMatchObject({
      item: "huevos",
      content: "Huevos de campo",
    });
  });

  it("tasks, subtasks and task lists; descriptions and notes untouched", () => {
    const task = createTaskInput.parse({
      title: "llamar a Marco",
      description: "sobre el presupuesto",
      notes: "antes de las 10",
    });
    expect(task).toMatchObject({
      title: "Llamar a Marco",
      description: "sobre el presupuesto",
      notes: "antes de las 10",
    });
    expect(createTaskInput.parse({ title: "revisar iPhone", parentTaskId: "x:task" }).title).toBe(
      "Revisar iPhone",
    );
    expect(updateTaskInput.parse({ taskId: "t1", title: "enviar propuesta" }).title).toBe(
      "Enviar propuesta",
    );
    expect(createTaskListInput.parse({ name: "clientes" }).name).toBe("Clientes");
  });

  it("habits, goals and visions", () => {
    expect(createHabitInput.parse({ name: "meditar", frequency: "daily" }).name).toBe("Meditar");
    expect(updateHabitInput.parse({ habit: "gym", name: "ir al gym" })).toMatchObject({
      habit: "gym",
      name: "Ir al gym",
    });
    expect(createGoalInput.parse({ title: "leer 12 libros" }).title).toBe("Leer 12 libros");
    expect(updateGoalInput.parse({ goal: "libros", title: "leer 20 libros" }).title).toBe(
      "Leer 20 libros",
    );
    expect(createVisionInput.parse({ title: "firbot Academy es referencia" }).title).toBe(
      "Firbot Academy es referencia",
    );
  });

  it("finance accounts and categories", () => {
    expect(createAccountInput.parse({ name: "efectivo" }).name).toBe("Efectivo");
    expect(createCategoryInput.parse({ name: "supermercado", type: "expense" }).name).toBe(
      "Supermercado",
    );
  });

  it("tool schemas still describe themselves to the model", () => {
    for (const tool of [...TASK_TOOLS, ...LIST_TOOLS])
      expect(() => ToolRegistry.toSpec(tool)).not.toThrow();
  });
});

describe("chat and the UI store the same title", () => {
  it.each(["ai", "user_ui"] as const)(
    "tasks.create from %s persists the normalized title",
    async (origin) => {
      const { ports, tasks } = makePorts();
      const out = await executeToolCall(ports, makeCtx({ origin }), {
        name: "tasks.create",
        args: { title: "comprar huevos para la semana" },
      });
      expect(out.status).toBe("succeeded");
      expect([...tasks.tasks.values()].map((t) => t.title)).toEqual([
        "Comprar huevos para la semana",
      ]);
      // What the answer and the Surface show is the stored value.
      if (out.status === "succeeded" && out.display?.kind === "task")
        expect(out.display.task.title).toBe("Comprar huevos para la semana");
    },
  );
});
