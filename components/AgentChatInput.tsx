import { Send } from 'lucide-react';
import React from 'react';

export interface AgentChatInputProps {
    input: string;
    handleInputChange: any;
    handleSubmit: (e: React.FormEvent | React.KeyboardEvent) => void;
    isInputDisabled: boolean;
}

export function AgentChatInput({ input, handleInputChange, handleSubmit, isInputDisabled }: AgentChatInputProps) {
    return (
        <footer className="border-t border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-black shrink-0 w-full">
            <div className="mx-auto max-w-3xl">
                <form
                    onSubmit={handleSubmit as any}
                    className="flex relative items-end overflow-hidden rounded-2xl border transition-all shadow-sm border-zinc-300 bg-zinc-50 focus-within:ring-2 focus-within:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:ring-white"
                >
                    <textarea
                        rows={1}
                        value={input}
                        onChange={handleInputChange}
                        disabled={isInputDisabled}
                        placeholder="Type an instruction or answer here... (Enter to send, Shift+Enter for newline)"
                        onInput={(e) => {
                            const el = e.currentTarget;
                            el.style.height = "auto";
                            el.style.height = Math.min(el.scrollHeight, 200) + "px";
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                if (!isInputDisabled) handleSubmit(e);
                            }
                        }}
                        className="w-full bg-transparent px-4 py-3 pr-14 text-sm outline-none placeholder:text-zinc-500 disabled:cursor-not-allowed resize-none leading-relaxed"
                        style={{ minHeight: "48px", maxHeight: "200px" }}
                    />
                    <button
                        type="submit"
                        disabled={isInputDisabled || !input.trim()}
                        className="absolute right-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-black text-white transition-transform hover:scale-105 disabled:opacity-50 disabled:hover:scale-100 dark:bg-white dark:text-black cursor-pointer disabled:cursor-not-allowed"
                    >
                        <Send size={18} />
                    </button>
                </form>
            </div>
        </footer>
    );
}
