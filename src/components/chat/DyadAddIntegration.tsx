import React, { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
import { pendingIntegrationAtom } from "@/atoms/planAtoms";
import { useAtom, useAtomValue } from "jotai";
import { useLoadApp } from "@/hooks/useLoadApp";
import { useNeon } from "@/hooks/useNeon";
import { useTranslation } from "react-i18next";
import { isNextJsProject } from "@/lib/framework_constants";
import { CheckCircle2, Database, ExternalLink } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { DyadCard, DyadCardHeader, DyadBadge } from "./DyadCardPrimitives";
import { getCompletedIntegrationProvider } from "./dyadAddIntegrationUtils";
import { ipc } from "@/ipc/types";
import { planClient } from "@/ipc/types/plan";
import { SupabaseConnector } from "@/components/SupabaseConnector";
import { NeonConnector } from "@/components/NeonConnector";

interface DyadAddIntegrationProps {
  children: React.ReactNode;
  provider?: "neon" | "supabase";
}

export const DyadAddIntegration: React.FC<DyadAddIntegrationProps> = ({
  children,
  provider: requestedProvider,
}) => {
  const { t } = useTranslation("home");
  const appId = useAtomValue(selectedAppIdAtom);
  const chatId = useAtomValue(selectedChatIdAtom);
  const [pendingIntegrationMap, setPendingIntegrationMap] = useAtom(
    pendingIntegrationAtom,
  );
  const pendingIntegration =
    chatId != null ? pendingIntegrationMap.get(chatId) : undefined;
  const { app } = useLoadApp(appId);
  const { projectInfo, isLoadingBranches } = useNeon(appId);
  const isNextJs = isNextJsProject({
    files: app?.files,
    frameworkType: app?.frameworkType ?? null,
  });

  const [selectedProvider, setSelectedProvider] = useState<
    "neon" | "supabase" | null
  >(requestedProvider ?? pendingIntegration?.provider ?? "supabase");

  const providerOptions = [
    {
      id: "supabase" as const,
      name: t("integrations.databaseSetup.providers.supabase.name"),
      description: t(
        "integrations.databaseSetup.providers.supabase.description",
      ),
      url: "https://supabase.com",
      experimental: false,
    },
    {
      id: "neon" as const,
      name: t("integrations.databaseSetup.providers.neon.name"),
      description: t("integrations.databaseSetup.providers.neon.description"),
      url: "https://neon.tech",
      experimental: true,
    },
  ];

  const lockedProvider = requestedProvider ?? pendingIntegration?.provider;

  // Determine which providers to show
  const availableProviders = (() => {
    // If a specific provider was requested (via tool arg or pending request),
    // show only that one (but fall back to supabase if neon was requested for non-Next.js)
    if (lockedProvider) {
      if (lockedProvider === "neon" && !isNextJs) {
        return providerOptions.filter((p) => p.id === "supabase");
      }
      return providerOptions.filter((p) => p.id === lockedProvider);
    }
    // No provider specified: show neon only for Next.js projects
    if (!isNextJs) {
      return providerOptions.filter((p) => p.id !== "neon");
    }
    return providerOptions;
  })();

  // When only one provider is available, treat it as pre-selected
  const effectiveSelectedProvider =
    availableProviders.length === 1
      ? availableProviders[0].id
      : selectedProvider;

  const radioGroupRef = useRef<HTMLDivElement>(null);

  const handleRadioKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key))
      return;
    e.preventDefault();

    const buttons =
      radioGroupRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="radio"]',
      );
    if (!buttons || buttons.length === 0) return;

    const currentIndex = Array.from(buttons).findIndex(
      (btn) => btn === document.activeElement,
    );
    const nextIndex =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? (currentIndex + 1) % buttons.length
        : (currentIndex - 1 + buttons.length) % buttons.length;

    buttons[nextIndex].focus();
    const providerId = availableProviders[nextIndex]?.id;
    if (providerId) setSelectedProvider(providerId);
  };

  const completedProvider = getCompletedIntegrationProvider(app);
  const completedProviderName =
    completedProvider === "supabase"
      ? t("integrations.databaseSetup.providers.supabase.name")
      : completedProvider === "neon"
        ? t("integrations.databaseSetup.providers.neon.name")
        : null;

  const integrationLabel =
    completedProvider === "supabase" && app?.supabaseProjectName
      ? app.supabaseProjectName
      : completedProvider === "neon" && app?.neonProjectId
        ? (projectInfo?.projectName ??
          (isLoadingBranches ? null : app.neonProjectId))
        : null;
  const showIntegrationLabelSkeleton =
    completedProvider === "neon" &&
    !!app?.neonProjectId &&
    isLoadingBranches &&
    !projectInfo?.projectName;

  const clearPendingForChat = () => {
    if (chatId == null) return;
    setPendingIntegrationMap((prev) => {
      if (!prev.has(chatId)) return prev;
      const next = new Map(prev);
      next.delete(chatId);
      return next;
    });
  };

  const handleContinueClick = () => {
    if (!pendingIntegration || !completedProvider) return;
    planClient.respondToIntegration({
      requestId: pendingIntegration.requestId,
      provider: completedProvider,
      completed: true,
    });
    clearPendingForChat();
  };

  // Final completed view: no active pending request and the app has a linked
  // provider. This covers historical replays of completed chats too.
  if (completedProvider && !pendingIntegration) {
    return (
      <DyadCard accentColor="green" state="finished">
        <DyadCardHeader icon={<CheckCircle2 size={15} />} accentColor="green">
          <DyadBadge color="green">
            {t("integrations.databaseSetup.integrationComplete")}
          </DyadBadge>
          <span className="text-sm font-medium text-foreground">
            {t("integrations.databaseSetup.completeDescription", {
              provider: completedProviderName,
            })}
          </span>
        </DyadCardHeader>
        <div className="px-3 pb-3">
          <p className="text-sm text-muted-foreground">
            {t("integrations.databaseSetup.connectedToProject", {
              provider: completedProviderName,
            })}{" "}
            {showIntegrationLabelSkeleton ? (
              <Skeleton className="inline-block h-6 w-28 align-middle rounded bg-green-100/80 dark:bg-green-900/50" />
            ) : (
              <span className="font-mono font-medium px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200">
                {integrationLabel ?? "—"}
              </span>
            )}
          </p>
        </div>
      </DyadCard>
    );
  }

  // If there is no pending request for this chat and no completion, this is a
  // stale/historical render — show the radios in a read-only display state with
  // no Continue button (nothing to resolve).
  const isInteractive = !!pendingIntegration;
  const inlineConnectorProvider =
    isInteractive && !completedProvider ? effectiveSelectedProvider : null;

  return (
    <DyadCard accentColor="blue">
      <DyadCardHeader icon={<Database size={15} />} accentColor="blue">
        <DyadBadge color="blue">
          {t("integrations.databaseSetup.badge")}
        </DyadBadge>
        <span className="text-sm font-medium text-foreground">
          {t("integrations.databaseSetup.chooseProvider")}
        </span>
      </DyadCardHeader>
      <div className="px-3 pb-3">
        {children && (
          <div className="text-xs text-muted-foreground mb-3">{children}</div>
        )}
        <div
          ref={radioGroupRef}
          role="radiogroup"
          aria-label={t("integrations.databaseSetup.chooseProvider")}
          onKeyDown={handleRadioKeyDown}
          className={`grid ${availableProviders.length > 1 ? "grid-cols-2" : "grid-cols-1"} gap-3`}
        >
          {availableProviders.map((option, index) => {
            const isSelected = effectiveSelectedProvider === option.id;
            const disableSwitch =
              !isInteractive ||
              !!completedProvider ||
              availableProviders.length === 1;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                tabIndex={
                  isSelected || (!effectiveSelectedProvider && index === 0)
                    ? 0
                    : -1
                }
                onClick={() => {
                  if (disableSwitch) return;
                  setSelectedProvider(option.id);
                }}
                aria-checked={isSelected}
                aria-disabled={disableSwitch}
                className={`flex flex-col items-start gap-2 rounded-lg border-2 p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
                  isSelected
                    ? "border-blue-500 bg-blue-50/50 dark:bg-blue-950/30"
                    : "border-border hover:border-blue-400"
                } ${disableSwitch ? "cursor-default" : "cursor-pointer"}`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-foreground">
                    {option.name}
                  </span>
                  {option.experimental && (
                    <DyadBadge color="amber">
                      {t("integrations.databaseSetup.experimental")}
                    </DyadBadge>
                  )}
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      ipc.system.openExternalUrl(option.url);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        ipc.system.openExternalUrl(option.url);
                      }
                    }}
                    tabIndex={0}
                    className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                    role="link"
                    aria-label={`Visit ${option.name} website`}
                  >
                    <ExternalLink size={12} />
                  </span>
                </div>
                <p className="text-xs text-muted-foreground leading-snug">
                  {option.description}
                </p>
              </button>
            );
          })}
        </div>

        {inlineConnectorProvider && appId != null && (
          <div className="mt-4 rounded-lg border border-border bg-background/40 p-3">
            {inlineConnectorProvider === "supabase" ? (
              <SupabaseConnector appId={appId} />
            ) : (
              <NeonConnector appId={appId} />
            )}
          </div>
        )}

        {isInteractive && completedProvider && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200">
            <CheckCircle2 size={14} />
            <span>
              {t("integrations.databaseSetup.connectedToProject", {
                provider: completedProviderName,
              })}{" "}
              {showIntegrationLabelSkeleton ? (
                <Skeleton className="inline-block h-5 w-24 align-middle rounded bg-green-100/80 dark:bg-green-900/50" />
              ) : (
                <span className="font-mono font-medium">
                  {integrationLabel ?? "—"}
                </span>
              )}
            </span>
          </div>
        )}

        {isInteractive && (
          <Button
            onClick={handleContinueClick}
            disabled={!completedProvider}
            className="w-full mt-3"
            size="sm"
          >
            {t("integrations.databaseSetup.continue")}
          </Button>
        )}
      </div>
    </DyadCard>
  );
};
