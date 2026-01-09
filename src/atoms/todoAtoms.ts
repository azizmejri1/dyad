/**
 * Jotai atoms for TODO lists (per-chat)
 */

import { atom } from "jotai";
import type { TodoItem } from "@/ipc/ipc_types";

// Map of chatId -> TodoItem[]
export const todosByChatIdAtom = atom<Map<number, TodoItem[]>>(new Map());
