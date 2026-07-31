import { useAtom, useAtomValue } from "jotai";
import { KeyRound, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { dismissedLegacySupabaseKeyAppIdsAtom } from "@/atoms/supabaseAtoms";
import {
  useLegacySupabaseKey,
  useSwitchToPublishableKey,
} from "@/hooks/useLegacySupabaseKey";
import { showError, showSuccess } from "@/lib/toast";

/**
 * Non-blocking offer to move an app off the Supabase legacy `anon` key its
 * generated client was created with.
 *
 * The key is written into the app's source once, at generation time, and never
 * refreshed, so an app can sit on a retired key indefinitely — and the first
 * symptom is every request failing with "Legacy API keys are disabled",
 * which reads as broken auth code rather than an expired key. Surfacing it
 * beside the running preview catches it before that, since the failure hits
 * ordinary use, not just tests.
 *
 * Renders nothing unless a legacy key is detected and a publishable key exists
 * to replace it. A completed switch re-runs detection, so the banner clears
 * itself.
 */
export function SupabaseKeyWarningBanner() {
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const [dismissedIds, setDismissedIds] = useAtom(
    dismissedLegacySupabaseKeyAppIdsAtom,
  );
  const dismissed = selectedAppId != null && dismissedIds.has(selectedAppId);
  const legacyQuery = useLegacySupabaseKey(selectedAppId, !dismissed);
  const switchKey = useSwitchToPublishableKey();

  if (dismissed || !legacyQuery.data?.hasLegacyKey) {
    return null;
  }

  const dismiss = () => {
    if (selectedAppId == null) return;
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(selectedAppId);
      return next;
    });
  };

  const handleSwitch = async () => {
    if (selectedAppId == null) return;
    try {
      const { updated } = await switchKey.mutateAsync({ appId: selectedAppId });
      if (updated) {
        showSuccess(
          "Updated the app's Supabase key. Restart the app to pick it up.",
        );
      }
    } catch (error) {
      showError(error);
    }
  };

  return (
    <div
      className="flex min-h-10 items-center gap-3 border-b border-amber-200/80 bg-amber-50/80 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100"
      data-testid="supabase-key-warning-banner"
    >
      <KeyRound className="size-4 shrink-0 text-amber-700 dark:text-amber-300" />
      <span className="min-w-0 flex-1 truncate">
        This app uses Supabase&apos;s legacy API key, which Supabase is
        retiring. Sign-in and data requests will fail once it&apos;s disabled.
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={handleSwitch}
          disabled={switchKey.isPending}
          data-testid="supabase-key-warning-banner-update"
        >
          {switchKey.isPending ? "Updating…" : "Update key"}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={dismiss}
          aria-label="Dismiss Supabase key warning"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
