import type { Meta, StoryObj } from '@storybook/react';
import { AgentChatInput } from './AgentChatInput';
import { useState } from 'react';

const meta = {
    title: 'Agent/AgentChatInput',
    component: AgentChatInput,
    parameters: {
        layout: 'fullscreen',
    },
    tags: ['autodocs'],
} satisfies Meta<typeof AgentChatInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
    render: (args) => {
        const [input, setInput] = useState('');
        return (
            <div className="w-full max-w-4xl mx-auto h-[300px] flex items-end">
                <AgentChatInput
                    {...args}
                    input={input}
                    handleInputChange={(e: any) => setInput(e.target.value)}
                    handleSubmit={(e: any) => {
                        e.preventDefault();
                        alert(`Submitted: ${input}`);
                        setInput('');
                    }}
                />
            </div>
        );
    },
    args: {
        input: '',
        isInputDisabled: false,
        handleInputChange: () => { },
        handleSubmit: () => { },
    },
};

export const Disabled: Story = {
    render: Default.render,
    args: {
        input: '',
        isInputDisabled: true,
        handleInputChange: () => { },
        handleSubmit: () => { },
    },
};

export const WithTextFilled: Story = {
    render: Default.render,
    args: {
        input: 'I would like to major in Computer Science',
        isInputDisabled: false,
        handleInputChange: () => { },
        handleSubmit: () => { },
    },
};
