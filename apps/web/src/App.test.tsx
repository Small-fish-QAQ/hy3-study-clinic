import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App shell', () => {
  it('renders the application title', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Hy3 智学诊所' })).toBeInTheDocument();
  });

  it('renders the subtitle describing the study flows', () => {
    render(<App />);
    expect(screen.getByText(/证据可溯源/)).toBeInTheDocument();
  });
});
