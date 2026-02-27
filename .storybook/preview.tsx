import '../app/globals.css';
import type { Preview } from '@storybook/react';

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'light',
      values: [
        { name: 'light', value: '#ffffff' },
        { name: 'dark', value: '#18181b' },
      ],
    },
  },
  decorators: [
    (Story, context) => {
      const mode = context.globals.backgrounds?.value === '#18181b' ? 'dark' : 'light';
      // Add 'dark' class to html element when dark background is selected
      if (typeof document !== 'undefined') {
        if (mode === 'dark') {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
      }
      return <div className="antialiased font-sans text-zinc-900 dark:text-zinc-100 min-h-screen p-4 flex justify-center items-start"><Story /></div>;
    },
  ],
};

export default preview;