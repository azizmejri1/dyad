/**
 * Types for the TODO tool
 */

import { z } from "zod";

// ============================================================================
// TODO Item Types
// ============================================================================

export type TodoStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface TodoItem {
  id: string;
  description: string;
  status: TodoStatus;
  dependency?: string; // ID of the task this depends on
}

// ============================================================================
// Zod Schemas
// ============================================================================

export const todoItemSchema = z.object({
  id: z
    .string()
    .describe("Unique identifier for the task (e.g., 'task-1', 'auth-setup')"),
  description: z.string().describe("Description of the task"),
  status: z
    .enum(["pending", "in_progress", "completed", "blocked"])
    .describe("Current status of the task"),
  dependency: z
    .string()
    .optional()
    .describe("ID of another task that must be completed first"),
});

export const todoWriteSchema = z.object({
  action: z
    .enum(["create", "update", "clear"])
    .describe(
      "Action to perform: 'create' to add new tasks (or replace all), 'update' to modify existing task status, 'clear' to remove all tasks",
    ),
  todos: z
    .array(todoItemSchema)
    .optional()
    .describe(
      "Array of todo items (required for 'create' and 'update' actions)",
    ),
});

export type TodoWriteInput = z.infer<typeof todoWriteSchema>;
