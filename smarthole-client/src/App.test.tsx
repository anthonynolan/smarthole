import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import App from './App';

test('renders the Google client ID from GET /api/config', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ googleClientId: 'test-client-id.apps.googleusercontent.com' })
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<App />);

  await waitFor(() => {
    expect(screen.getByTestId('google-client-id')).toHaveTextContent(
      'test-client-id.apps.googleusercontent.com'
    );
  });
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/config',
    expect.objectContaining({ credentials: 'same-origin' })
  );

  vi.unstubAllGlobals();
});
