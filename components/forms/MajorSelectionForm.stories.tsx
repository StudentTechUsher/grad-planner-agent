import type { Meta, StoryObj } from '@storybook/react';
import { MajorSelectionForm } from './MajorSelectionForm';

const meta = {
    title: 'Forms/MajorSelectionForm',
    component: MajorSelectionForm,
    parameters: {
        layout: 'centered',
    },
    tags: ['autodocs'],
    args: {
        tool: { toolName: 'requestMajorSelection', toolCallId: 'call_mock' },
        addToolOutput: (output: any) => console.log('Mock addToolOutput:', output),
        sendMessage: (msg: any) => console.log('Mock sendMessage:', msg),
    }
} satisfies Meta<typeof MajorSelectionForm>;

export default meta;
type Story = StoryObj<typeof meta>;

const mockProgramsList = [
    { name: 'Computer Science (BS)' },
    { name: 'Information Systems (BS)' },
    { name: 'Cybersecurity (BS)' },
    { name: 'Accounting (BS)' },
    { name: 'Finance (BS)' },
    { name: 'English (BA)' },
];

export const Default: Story = {
    args: {
        mockPrograms: mockProgramsList,
    },
};

export const WithoutMockDataLoading: Story = {
    args: {
    },
};
