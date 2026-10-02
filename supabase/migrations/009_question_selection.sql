-- Allow switching among a participant's existing assigned questions.
-- Existing attempts and question orders are retained. A suspended attempt keeps
-- its distraction schedule and elapsed active time until the participant resumes it.
ALTER TABLE public.round_attempts
    ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

COMMENT ON COLUMN public.round_attempts.suspended_at IS
    'Time the participant selected another question; distinct from a distraction pause.';

-- The participation row lock serializes selections. Enforce the same invariant
-- in the database: at most one currently selected, unfinished question per player.
CREATE UNIQUE INDEX IF NOT EXISTS idx_round_attempts_one_selected
    ON public.round_attempts (user_id)
    WHERE status = 'active' AND suspended_at IS NULL;
