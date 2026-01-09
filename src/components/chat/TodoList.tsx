import React from "react";
import { useAtom } from "jotai";
import { todosByChatIdAtom } from "@/atoms/todoAtoms";
import {
  ChevronDown,
  ChevronUp,
  Circle,
  CheckCircle2,
  Loader2,
  Ban,
  ListTodo,
} from "lucide-react";
import type { TodoItem } from "@/ipc/ipc_types";

interface TodoListProps {
  chatId?: number;
}

const statusConfig: Record<
  string,
  { icon: React.ReactNode; className: string; label: string }
> = {
  pending: {
    icon: <Circle className="w-3.5 h-3.5" />,
    className: "text-muted-foreground",
    label: "Pending",
  },
  in_progress: {
    icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
    className: "text-blue-500",
    label: "In Progress",
  },
  completed: {
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
    className: "text-green-500",
    label: "Completed",
  },
  blocked: {
    icon: <Ban className="w-3.5 h-3.5" />,
    className: "text-orange-500",
    label: "Blocked",
  },
};

function TodoItemRow({ todo }: { todo: TodoItem }) {
  const config = statusConfig[todo.status] ?? statusConfig.pending;

  return (
    <div className="flex items-start gap-2 py-1">
      <span
        className={`flex-shrink-0 mt-0.5 ${config.className}`}
        title={config.label}
      >
        {config.icon}
      </span>
      <div className="flex-1 min-w-0">
        <span
          className={`text-sm ${
            todo.status === "completed"
              ? "line-through text-muted-foreground"
              : ""
          }`}
        >
          {todo.description}
        </span>
      </div>
    </div>
  );
}

export function TodoList({ chatId }: TodoListProps) {
  const [todosById] = useAtom(todosByChatIdAtom);
  const [isExpanded, setIsExpanded] = React.useState(true);

  if (!chatId) return null;

  const todos = todosById.get(chatId) ?? [];

  if (todos.length === 0) return null;

  const completedCount = todos.filter((t) => t.status === "completed").length;
  const totalCount = todos.length;

  return (
    <div className="border-b border-border bg-muted/30">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 p-2 text-left hover:bg-muted/50 transition-colors"
      >
        <ListTodo className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <span className="text-sm font-medium flex-1">
          Tasks ({completedCount}/{totalCount})
        </span>
        {isExpanded ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        )}
      </button>

      {isExpanded && (
        <div className="px-2 pb-2">
          <div className="pl-6 space-y-0.5">
            {todos.map((todo) => (
              <TodoItemRow key={todo.id} todo={todo} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
