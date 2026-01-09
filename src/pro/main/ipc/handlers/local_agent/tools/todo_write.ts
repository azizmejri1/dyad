/**
 * TODO Write Tool - Create and update to-do lists
 *
 * This tool helps break down complex tasks into smaller, actionable subtasks,
 * making progress easier to track and improving execution quality.
 */

import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import { todoWriteSchema, TodoItem, TodoWriteInput } from "./todo_types";
import { safeSend } from "@/ipc/utils/safe_sender";

// ============================================================================
// In-Memory Todo Store (per chat)
// ============================================================================

const todoStore = new Map<number, TodoItem[]>();

export function getTodos(chatId: number): TodoItem[] {
  return todoStore.get(chatId) ?? [];
}

export function setTodos(chatId: number, todos: TodoItem[]): void {
  todoStore.set(chatId, todos);
}

export function clearTodos(chatId: number): void {
  todoStore.delete(chatId);
}

// ============================================================================
// XML Building Helpers
// ============================================================================

function buildTodoXml(todos: TodoItem[], isComplete: boolean): string {
  if (todos.length === 0) {
    return `<dyad-todo count="0"${isComplete ? "" : ' loading="true"'}></dyad-todo>`;
  }

  const todoLines = todos
    .map((todo) => {
      const depAttr = todo.dependency
        ? ` dependency="${escapeXmlAttr(todo.dependency)}"`
        : "";
      return `  <task id="${escapeXmlAttr(todo.id ?? "")}" status="${todo.status ?? "pending"}"${depAttr}>${escapeXmlContent(todo.description ?? "")}</task>`;
    })
    .join("\n");

  return `<dyad-todo count="${todos.length}"${isComplete ? "" : ' loading="true"'}>
${todoLines}
</dyad-todo>`;
}

// ============================================================================
// Tool Definition
// ============================================================================

export const todoWriteTool: ToolDefinition<TodoWriteInput> = {
  name: "todo_write",
  description: `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## WHEN YOU MUST USE THE TODO LIST

You MUST create or update a todo list when any of the following conditions are true:

### Multi-step work
- The task requires more than 3 steps
- The task involves multiple phases (analysis → implementation → verification)

### Non-trivial tasks
- The task affects multiple files, components, or systems
- The task includes refactoring, migrations, or performance work
- The task has side effects or dependencies

### Explicit user intent
- The user asks for a todo list, plan, checklist, or steps
- The user provides multiple tasks in a single prompt

### Task lifecycle events
- A task was just completed → mark it as completed
- New follow-up work emerges → append new tasks
- A new task is being started → create it and mark its initial state

### Verification requirements
- The task requires tests, builds, validation, or reviews
- The user explicitly mentions "make sure", "verify", "ensure", or "don't forget"

If ANY rule above applies, you MUST use the todo list.
Failure to do so is a correctness error.

## WHEN YOU MUST NOT USE THE TODO LIST (STRICT PROHIBITION)

You MUST NOT create a todo list when all of the following are true:

### Single, atomic task
- The task can be completed in fewer than 3 steps
- No intermediate state tracking is required

### Purely informational
- The user is asking for explanations, definitions, comparisons, or opinions
- No action, execution, or modification is implied

### One-shot operations
- Formatting, renaming a single symbol, fixing a typo
- Simple code edits with no cascading impact

### Conversational prompts
- The prompt is discussion-based, hypothetical, or subjective
- There is no concrete task to execute

If the task does not clearly benefit from planning or tracking, DO NOT use the todo list.
Using it in these cases is considered tool misuse.

## Example 1 — Implementing a Multi-Step Feature

User: I want to add a dark mode toggle to the application settings. Make sure you run the tests and build when you're done.
Assistant: I'll help add a dark mode toggle to your application settings. I'll create a todo list to track this implementation.
Creates a todo list:
1. Add a dark mode toggle component to the Settings page
2. Implement dark mode state management (context/store)
3. Define and apply dark theme styles
4. Update existing components to support theme switching
5. Run tests and the build process, fixing any failures
Begins working on the first task

Why the todo list was used:
- The feature requires multiple dependent steps (UI, state, styling).
- The user explicitly requested verification (tests and build).
- Tracking progress reduces the risk of missed steps.

## Example 2 — Refactoring Across a Codebase

User: Help me rename the function getCwd to getCurrentWorkingDirectory across my project.
Assistant: Let me first search the codebase to find all occurrences of getCwd.
Searches the codebase and finds multiple occurrences across several files.
I've identified all usages of getCwd. I'll create a todo list to ensure each instance is updated correctly.
Creates a todo list:
1. Update the function definition in core utilities
2. Update imports and usages in all affected files
3. Update tests referencing getCwd
4. Run tests and verify no regressions

Why the todo list was used:
- The scope required investigation before changes could begin.
- The task spans multiple files and references.
- A todo list prevents missing updates and inconsistencies.

## Example 3 — Multiple Features in a Single Request

User: I need to implement these features for my e-commerce site: user registration, product catalog, shopping cart, and checkout flow.
Assistant: I'll help implement these features. First, I'll create a todo list to organize the work.
Creates a todo list:
1. Implement user registration (database models, APIs, UI)
2. Build the product catalog (listing, details, search)
3. Implement the shopping cart (state, persistence, UI)
4. Build the checkout flow (validation, payment, confirmation)
5. Perform end-to-end testing of the full purchase flow
Starts with user registration

Why the todo list was used:
- The user provided multiple complex tasks in one prompt.
- Each feature requires multiple coordinated steps.
- A todo list provides structure and sequencing.

## Example 4 — Performance Optimization After Analysis

User: Can you help optimize my React application? It's rendering slowly and has performance issues.
Assistant: I'll start by reviewing the codebase to identify performance bottlenecks.
Reviews component structure, render patterns, state usage, and data fetching.
I've identified several performance issues. I'll create a todo list to track the optimizations.
Creates a todo list:
1. Add memoization for expensive calculations in ProductList
2. Implement list virtualization in Dashboard
3. Optimize image loading in the Gallery component
4. Fix unnecessary re-renders in ShoppingCart
5. Review bundle size and apply code splitting

Why the todo list was used:
- Optimization required analysis before action.
- Multiple independent improvements were identified.
- The todo list ensures systematic coverage of issues.

## Example 5 — Building a Complete Application

User: Build me a task management app.
Assistant: I'll build a complete task management application for you. Let me create a todo list to organize this implementation.
Creates a todo list:
1. Set up project structure and install dependencies
2. Implement user authentication (registration, login, logout)
3. Create task data models and API routes
4. Build task CRUD operations (create, read, update, delete)
5. Implement the dashboard with task overview and statistics
6. Add styling and responsive design
7. Test all features and fix any issues
Begins with project setup

Why the todo list was used:
- Building a complete app is a large, multi-phase undertaking.
- Multiple interconnected features must be implemented in sequence.
- The todo list ensures no critical functionality is overlooked.
- Progress tracking helps the user understand the current state.

## Counter-Example 1 — Single, Straightforward Task

User: Can you rename this variable from usr to user?
Assistant: Sure — I'll rename usr to user.

Why the todo list was NOT used:
- The task is atomic and trivial.
- It can be completed in a single step.
- A todo list would add unnecessary overhead.

## Counter-Example 2 — Informational Request

User: What is the difference between let, var, and const in JavaScript?
Assistant: Here's a breakdown of the differences between let, var, and const.

Why the todo list was NOT used:
- The request is purely informational.
- No execution or planning is required.

## Counter-Example 3 — Small Task With Fewer Than 3 Steps

User: Add a console log when the user clicks the submit button.
Assistant: I'll add a log statement to the submit handler.

Why the todo list was NOT used:
- The task is small and well-scoped.
- It does not require tracking or decomposition.

## Counter-Example 4 — Conversational or Opinion-Based Prompt

User: Do you think dark mode should be enabled by default?
Assistant: It depends on your audience and usage patterns.

Why the todo list was NOT used:
- The prompt is conversational and subjective.
- There is no actionable task to track.

## Counter-Example 5 — One-Shot Operation

User: Format this JSON file.
Assistant: I've formatted the JSON for readability.

Why the todo list was NOT used:
- The task is a single deterministic operation.
- No follow-up or verification steps are needed.
`,

  inputSchema: todoWriteSchema,
  defaultConsent: "always",

  buildXml: (args, isComplete) => {
    // Show loading state while streaming
    if (!args.action) {
      return `<dyad-todo loading="true"></dyad-todo>`;
    }

    // For streaming, show the todos being created/updated
    if (args.todos && args.todos.length > 0) {
      return buildTodoXml(args.todos as TodoItem[], isComplete);
    }

    if (args.action === "clear") {
      return `<dyad-todo count="0" cleared="true"></dyad-todo>`;
    }

    return `<dyad-todo loading="true"></dyad-todo>`;
  },

  execute: async (args, ctx: AgentContext) => {
    const currentTodos = getTodos(ctx.chatId);
    let updatedTodos: TodoItem[];

    switch (args.action) {
      case "create":
        // Replace all todos with new ones
        updatedTodos = (args.todos ?? []) as TodoItem[];
        setTodos(ctx.chatId, updatedTodos);
        break;

      case "update":
        // Update specific todos by ID
        const updateMap = new Map(
          ((args.todos ?? []) as TodoItem[]).map((t) => [t.id, t]),
        );
        updatedTodos = currentTodos.map((existing) => {
          const update = updateMap.get(existing.id);
          return update ? { ...existing, ...update } : existing;
        });
        // Also add any new todos that weren't in the current list
        for (const todo of (args.todos ?? []) as TodoItem[]) {
          if (!currentTodos.find((t) => t.id === todo.id)) {
            updatedTodos.push(todo);
          }
        }
        setTodos(ctx.chatId, updatedTodos);
        break;

      case "clear":
        updatedTodos = [];
        clearTodos(ctx.chatId);
        break;

      default:
        throw new Error(`Unknown action: ${args.action}`);
    }

    // Send update to renderer
    safeSend(ctx.event.sender, "todo:update", {
      chatId: ctx.chatId,
      todos: updatedTodos,
    });

    // Output final XML
    ctx.onXmlComplete(buildTodoXml(updatedTodos, true));

    // Return summary for AI
    const summary =
      args.action === "clear"
        ? "Cleared all todos"
        : `${args.action === "create" ? "Created" : "Updated"} ${updatedTodos.length} todo(s)`;

    return summary;
  },
};
