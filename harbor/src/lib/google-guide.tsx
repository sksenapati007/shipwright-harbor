import { GOOGLE_GUIDE_URL } from './config';

/** A link to the client ID guide, shown only while no client ID has been entered. */
export function GoogleGuideLink({ clientId }: { clientId: string }) {
  if (clientId.trim()) return null;
  return (
    <p class="muted small" data-testid="google-guide-link">
      No client ID yet?{' '}
      <a href={GOOGLE_GUIDE_URL} target="_blank" rel="noopener noreferrer">
        Follow the step-by-step guide to create one
      </a>
      .
    </p>
  );
}
