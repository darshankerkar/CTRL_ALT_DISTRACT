import { useEffect, useRef } from "react";
import { Button } from "../../components/ui/Button";

export function ExitChallengeDialog({
  open,
  exiting,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  exiting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      role="alertdialog"
      aria-labelledby="exit-challenge-title"
      aria-describedby="exit-challenge-description"
      aria-modal="true"
      aria-busy={exiting}
      onCancel={(event) => {
        event.preventDefault();
        if (!exiting) onCancel();
      }}
      className="fixed inset-0 m-auto w-[calc(100%_-_2rem)] max-w-[460px] border-2 border-danger/60 bg-bg-elevated p-6 text-text-primary backdrop:bg-black/75 backdrop:backdrop-blur-sm"
    >
      <h2 id="exit-challenge-title" className="font-sans text-xl font-semibold">
        Exit the challenge?
      </h2>
      <div id="exit-challenge-description" className="mt-3 space-y-3 font-body text-sm text-text-secondary">
        <p>Your participation will end, and you cannot resume or rejoin this event.</p>
        <p>All points already earned will stay saved and visible on the leaderboard. An unfinished problem earns no points.</p>
      </div>
      {error && <p className="mt-4 font-body text-sm text-danger" role="alert">{error}</p>}
      {exiting && <p className="mt-4 font-body text-sm text-text-secondary" role="status">Saving your final progress…</p>}
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          disabled={exiting}
          className="h-11 rounded-sm border border-border-strong bg-transparent px-5 font-sans text-[15px] font-bold uppercase tracking-[0.06em] text-text-primary transition-all hover:border-text-muted hover:bg-bg-hover disabled:cursor-not-allowed disabled:text-text-disabled"
        >
          Keep coding
        </button>
        <Button variant="danger" onClick={onConfirm} loading={exiting} loadingLabel="Exiting…">
          Exit challenge
        </Button>
      </div>
    </dialog>
  );
}
