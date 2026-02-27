"use client";

import { useChat } from "@ai-sdk/react";
import {
  User, Bot, Send, CheckCircle2, FileText, UploadCloud, FileEdit, Building2, BriefcaseIcon, Loader2, LibraryBig, ChevronDown, ChevronRight, Edit3, Upload
} from "lucide-react";
import { AgentChatInput } from "../components/AgentChatInput";
import { MajorSelectionForm } from "../components/forms/MajorSelectionForm";
import { useState, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";

export default function Home() {
  const { messages, sendMessage, status, addToolResult, addToolOutput } = useChat();
  const [input, setInput] = useState("");
  const isLoading = status === "submitted" || status === "streaming";

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement> | React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    // If the user types a manual message while the AI is waiting for a tool form to be submitted,
    // we should forcefully resolve the pending tool calls so the AI SDK doesn't hang.
    if (messages.length > 0) {
      const lastMsg: any = messages[messages.length - 1];
      if (lastMsg.toolInvocations) {
        lastMsg.toolInvocations
          .filter((t: any) => !('result' in t))
          .forEach((t: any) => {
            try {
              // @ts-ignore
              if (addToolResult) addToolResult({ toolCallId: t.toolCallId, result: { action: "interrupted_by_user", userMessage: input } });
              else if (addToolOutput) addToolOutput({ tool: t.toolName || 'unknown', toolCallId: t.toolCallId, output: { action: "interrupted_by_user", userMessage: input } });
            } catch (err) { }
          });
      }
    }

    sendMessage({ text: input });
    setInput("");
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // App state
  const [progress, setProgress] = useState<{ total: number; completed: number } | null>(null);
  const [workflowStep, setWorkflowStep] = useState(0); // 0: Start, 1: Prefs, 2: Major, 3: Minor/GenEd, 4: Complete
  const [liveJson, setLiveJson] = useState<any>(null);
  const [transcriptCourses, setTranscriptCourses] = useState<any[]>([]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Extract progress from creditsCalculator tool and JSON scaffold from generateGradPlanScaffold
  useEffect(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as any;

      let tools = msg.toolInvocations || [];
      if (msg.parts) {
        tools = msg.parts
          .filter((p: any) => p.type.startsWith('tool-') || p.type === 'tool-call')
          .map((p: any) => ({
            toolCallId: p.toolCallId,
            toolName: p.toolName || p.type.replace('tool-', ''),
            state: p.state === 'output-available' || p.state === 'result' ? 'result' : 'call',
            args: p.args || p.input,
            result: p.result || p.output,
          }));
      }

      if (tools.length > 0) {
        for (const tool of tools) {
          // Progress logic (using functional updater so rapid tool calls resolve correctly)
          if (tool.toolName === "requestUserPreferences" && tool.state === "result") setWorkflowStep(prev => Math.max(prev, 1));
          if (tool.toolName === "requestMajorSelection" && tool.state === "result") setWorkflowStep(prev => Math.max(prev, 2));
          if (tool.toolName === "selectMajorCourses" && tool.state === "result") setWorkflowStep(prev => Math.max(prev, 3));
          if (tool.toolName === "requestMinorSelection" && tool.state === "result") setWorkflowStep(prev => Math.max(prev, 4));
          if ((tool.toolName === "selectMinorCourses" || tool.toolName === "selectGenEdCourses" || tool.toolName === "requestGenEdSelection") && tool.state === "result") setWorkflowStep(prev => Math.max(prev, 5));
          if (tool.toolName === "getStudentTranscript" && tool.state === "result") setWorkflowStep(prev => Math.max(prev, 6));

          if (tool.toolName === "creditsCalculator" && tool.state === "result") {
            const { totalRequired, completedCredits } = tool.args;
            setProgress({ total: totalRequired, completed: completedCredits });
          }
          if (tool.toolName === "generateGradPlanScaffold" && tool.state === "result" && tool.result?.scaffold) {
            setLiveJson(tool.result.scaffold);
            setWorkflowStep(prev => Math.max(prev, 7));
          }
        }
      }
    }
  }, [messages]);

  const percentage = progress ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : 0;

  // Disable input only while the agent is actively streaming/thinking
  const isInputDisabled = isLoading;

  return (
    <div className="flex h-screen w-full bg-zinc-50 dark:bg-zinc-950 font-sans text-zinc-900 dark:text-zinc-100 selection:bg-zinc-300 dark:selection:bg-zinc-700">

      {/* LEFT COLUMN: CHAT */}
      <div className="flex w-full lg:w-3/5 flex-col border-r border-zinc-200 dark:border-zinc-800 relative z-10 transition-all">
        {/* Header */}
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-6 bg-white dark:bg-black z-10">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-black text-white dark:bg-white dark:text-black shadow-sm">
              <Bot size={18} />
            </div>
            <h1 className="text-lg font-medium tracking-tight">Grad Planner AI</h1>
          </div>
          {/* Workflow Progress (If initialized) */}
          {workflowStep > 0 && (
            <div className="flex items-center gap-3 text-xs font-medium">
              <span className="text-zinc-500 hidden sm:inline">
                {workflowStep === 5 ? "Plan Complete" : `Step ${workflowStep} of 5`}
              </span>
              <div className="h-2 w-24 sm:w-32 md:w-32 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${(workflowStep / 5) * 100}%` }}
                  className="h-full bg-blue-500"
                />
              </div>
            </div>
          )}

          {/* Credit Progress */}
          {progress && (
            <div className="flex items-center gap-3 text-xs font-medium border-l border-zinc-200 dark:border-zinc-800 pl-4 ml-2">
              <span className="text-zinc-500 hidden sm:inline">{percentage}% Credits</span>
              <div className="h-2 w-24 sm:w-32 md:w-32 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${percentage}%` }}
                  className="h-full bg-black dark:bg-white"
                />
              </div>
            </div>
          )}
        </header>

        {/* Chat Area */}
        <main className="flex-1 overflow-y-auto px-4 py-8 sm:px-6 md:px-8">
          <div className="mx-auto max-w-3xl space-y-8">
            {messages.length === 0 ? (
              <div className="flex h-[50vh] flex-col items-center justify-center text-center space-y-5 text-zinc-400">
                <Bot size={56} className="opacity-20" />
                <div className="max-w-md space-y-2">
                  <p className="text-xl font-medium text-zinc-700 dark:text-zinc-200">Welcome to Grad Planner.</p>
                  <p className="text-sm leading-relaxed text-zinc-500 mb-6">I will guide you step-by-step through generating your graduation plan.</p>
                  <button
                    onClick={() => sendMessage({ text: "Hello, please review my preferences so we can start generating my graduation plan." })}
                    className="rounded-xl bg-black px-6 py-3 text-sm font-medium text-white transition-transform hover:scale-105 dark:bg-white dark:text-black shadow-sm"
                  >
                    Generate New Grad Plan
                  </button>
                </div>
              </div>
            ) : (
              messages.map((m: any) => {
                const rawContent: string = (m as any).content || (m as any).parts?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('') || '';
                const isSystemMsg = rawContent.startsWith('[System:');

                // Parse [System: ...] messages into a friendly label
                const systemLabel = (() => {
                  if (!isSystemMsg) return null;
                  if (rawContent.includes('selectMajorCourses') || rawContent.includes('Major confirmed')) {
                    const match = rawContent.match(/Major confirmed as '([^']+)'/);
                    return match ? `✓ Major selected: ${match[1]}` : '✓ Major confirmed';
                  }
                  if (rawContent.includes('Minor confirmed')) {
                    const match = rawContent.match(/Minor confirmed/);
                    return '✓ Minor confirmed';
                  }
                  if (rawContent.includes('selectMinorCourses')) {
                    const match = rawContent.match(/programName='([^']+)'/);
                    return match ? `✓ Minor selected: ${match[1]}` : '✓ Minor confirmed';
                  }
                  if (rawContent.includes('not to add a minor') || rawContent.includes('selectGenEdCourses') && rawContent.includes('minor')) {
                    return '✓ No minor selected';
                  }
                  if (rawContent.includes('Major course selections submitted')) {
                    return '✓ Major courses submitted';
                  }
                  if (rawContent.includes('Minor course selections submitted')) {
                    return '✓ Minor courses submitted';
                  }
                  if (rawContent.includes('Gen Ed course selections submitted') || rawContent.includes('getStudentTranscript')) {
                    return '✓ Gen Ed selections submitted';
                  }
                  if (rawContent.includes('getStudentTranscript') || rawContent.includes('transcript')) {
                    return '✓ Transcript provided';
                  }
                  if (rawContent.includes('preferences') || rawContent.includes('requestMajorSelection')) {
                    return '✓ Preferences saved';
                  }
                  return '✓ Step completed';
                })();

                return (
                  <div key={m.id} className={`flex gap-4 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
                    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${m.role === "user" ? "bg-zinc-200 dark:bg-zinc-800" : "bg-black text-white dark:bg-white dark:text-black"}`}>
                      {m.role === "user" ? <User size={16} /> : <Bot size={16} />}
                    </div>

                    <div className={`flex flex-col gap-2 max-w-[90%] ${m.role === "user" ? "items-end" : "items-start"}`}>
                      {rawContent && (
                        isSystemMsg ? (
                          // Show a compact confirmation chip instead of raw [System: ...] text
                          <div className="flex items-center gap-1.5 rounded-full bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                            <CheckCircle2 size={12} className="shrink-0" />
                            {systemLabel}
                          </div>
                        ) : (
                          <div className={`rounded-2xl px-5 py-3 text-sm leading-relaxed ${m.role === "user" ? "bg-zinc-200 dark:bg-zinc-800" : "bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-sm"}`}>
                            <span className="whitespace-pre-wrap">{rawContent}</span>
                          </div>
                        )
                      )}


                      {/* Tool Invocations Observability */}
                      {/* Only render Form components here for smooth UI. Logic/data tools go to the sidebar. */}
                      {(((m as any).toolInvocations) || ((m as any).parts?.filter((p: any) => p.type.startsWith('tool-') || p.type === 'tool-call').map((p: any) => ({
                        toolCallId: p.toolCallId,
                        toolName: p.toolName || p.type.replace('tool-', ''),
                        state: p.state === 'output-available' || p.state === 'result' ? 'result' : 'call',
                        args: p.args || p.input,
                        result: p.result || p.output,
                      }))))?.map((tool: any) => {
                        // Only render forms inline (UI interceptors)
                        if (tool.toolName.startsWith("request") || tool.toolName.startsWith("select") || tool.toolName === "getStudentTranscript" || tool.toolName === "presentMajorOptions" || tool.toolName === "requestCareerQuestionnaire" || tool.toolName === "queryPrograms") {
                          return (
                            <ToolInvocationCard
                              key={tool.toolCallId}
                              tool={tool}
                              addToolOutput={addToolOutput}
                              sendMessage={sendMessage}
                              liveJson={liveJson}
                              transcriptCourses={transcriptCourses}
                              onTranscriptParsed={setTranscriptCourses}
                            />
                          );
                        }
                        return null;
                      })}
                    </div>
                  </div>
                );
              })
            )}

            {isLoading && messages[messages.length - 1]?.role === "user" && (
              <div className="flex gap-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black text-white dark:bg-white dark:text-black">
                  <Bot size={16} />
                </div>
                <div className="flex items-center gap-2 rounded-2xl border border-zinc-200 bg-white px-5 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-900 shadow-sm text-zinc-500">
                  <Loader2 size={16} className="animate-spin" />
                  <span>Thinking...</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </main>

        {/* Input Area */}
        {messages.length > 0 && (
          <AgentChatInput
            input={input}
            handleInputChange={handleInputChange}
            handleSubmit={handleSubmit as any}
            isInputDisabled={isInputDisabled}
          />
        )}
      </div>

      {/* RIGHT COLUMN: JSON VIEWER & TOOL LOGS SIDEBAR */}
      <div className="hidden lg:flex w-2/5 flex-col bg-zinc-50 dark:bg-zinc-950 border-l border-zinc-200 dark:border-zinc-800">

        {/* Top Half: JSON Plan */}
        <div className="flex-1 flex flex-col min-h-[50%] border-b border-zinc-200 dark:border-zinc-800">
          <header className="flex h-16 shrink-0 items-center px-6 bg-white dark:bg-black z-10 border-b border-zinc-200 dark:border-zinc-800">
            <h2 className="text-sm font-semibold tracking-wide uppercase text-zinc-500">Live JSON Plan Viewer</h2>
          </header>
          <div className="flex-1 overflow-y-auto p-6 font-mono text-xs leading-relaxed bg-zinc-50 dark:bg-zinc-950">
            {liveJson ? (
              <pre className="p-4 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-sm overflow-x-auto text-zinc-800 dark:text-zinc-300">
                {JSON.stringify(liveJson, null, 2)}
              </pre>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-zinc-400 space-y-4">
                <div className="w-16 h-16 border-2 border-dashed border-zinc-300 dark:border-zinc-700 rounded-xl flex items-center justify-center">
                  <span className="text-2xl opacity-50">{'{ }'}</span>
                </div>
                <p>Grad plan scaffold not generated yet.</p>
              </div>
            )}
          </div>
        </div>

        {/* Bottom Half: Tool Execution Log */}
        <div className="flex-1 flex flex-col min-h-[50%] bg-zinc-100 dark:bg-black/50">
          <header className="flex h-12 shrink-0 items-center px-6 bg-zinc-200/50 dark:bg-zinc-900 z-10 border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-2 text-zinc-500">
              <Bot size={14} />
              <h2 className="text-xs font-semibold tracking-wider uppercase">Agent Tool Execution Log</h2>
            </div>
          </header>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.flatMap((m: any) =>
              ((m.toolInvocations) || (m.parts?.filter((p: any) => p.type.startsWith('tool-') || p.type === 'tool-call').map((p: any) => ({
                toolCallId: p.toolCallId,
                toolName: p.toolName || p.type.replace('tool-', ''),
                state: p.state === 'output-available' || p.state === 'result' ? 'result' : 'call',
                args: p.args || p.input,
                result: p.result || p.output,
              })))) || []
            ).map((tool: any) => (
              <ToolInvocationCard
                key={tool.toolCallId}
                tool={tool}
                addToolOutput={addToolOutput}
                sendMessage={sendMessage}
                isLog={true}
                liveJson={liveJson}
                transcriptCourses={transcriptCourses}
                onTranscriptParsed={setTranscriptCourses}
              />
            ))}
            {messages.length > 0 && messages.flatMap((m: any) => (m.toolInvocations) || m.parts).filter((p: any) => p && p.type && (p.type.startsWith('tool-') || p.type === 'tool-call')).length === 0 && (
              <div className="flex h-full items-center justify-center text-xs text-zinc-400">
                No backend tools executed yet.
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

function ToolInvocationCard({ tool, addToolOutput, sendMessage, isLog = false, liveJson, transcriptCourses, onTranscriptParsed }: { tool: any, addToolOutput: (args: any) => void, sendMessage: any, isLog?: boolean, liveJson?: any, transcriptCourses?: any[], onTranscriptParsed?: (courses: any[]) => void }) {
  const [expanded, setExpanded] = useState(false);
  const isComplete = tool.state === "result";

  if (!isLog) {
    // Specific Generators (Generative UI interception)
    if (!isComplete && tool.toolName === "requestUserPreferences") {
      return <PreferencesForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} onTranscriptParsed={onTranscriptParsed} />;
    }
    if (!isComplete && tool.toolName === "requestMajorSelection") {
      return <MajorSelectionForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} />;
    }
    if (!isComplete && tool.toolName === "requestCareerQuestionnaire") {
      return <CareerQuestionnaireForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} />;
    }
    if (tool.toolName === "presentMajorOptions" && tool.state !== "result") {
      return <MajorOptionsForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} />;
    }
    if (!isComplete && tool.toolName === "requestMinorSelection") {
      return <MinorSelectionForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} />;
    }
    if (!isComplete && tool.toolName === "requestGenEdSelection") {
      return <GenEdSelectionForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} transcriptCourses={transcriptCourses ?? []} />;
    }
    if (!isComplete && tool.toolName === "selectMajorCourses") {
      return <ProgramCourseSelectionForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} type="major" transcriptCourses={transcriptCourses ?? []} />;
    }
    if (!isComplete && tool.toolName === "selectMinorCourses") {
      return <ProgramCourseSelectionForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} type="minor" transcriptCourses={transcriptCourses ?? []} />;
    }
    if (!isComplete && tool.toolName === "selectGenEdCourses") {
      return <GenEdSelectionForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} transcriptCourses={transcriptCourses ?? []} />;
    }
    if (!isComplete && tool.toolName === "getStudentTranscript") {
      return <TranscriptUploadForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} />;
    }
    if (!isComplete && tool.toolName === "requestPlanReview") {
      return <PlanReviewForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} liveJson={liveJson} />;
    }

    // queryPrograms result: automatically show options form when recommendedPrograms are available
    if (tool.toolName === "queryPrograms" && isComplete && tool.result?.recommendedPrograms?.length > 0) {
      return <QueryProgramsOptionsForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} />;
    }
    // Still loading / no recommended programs yet — show nothing inline
    if (tool.toolName === "queryPrograms") return null;

    // Already submitted state for these forms
    if (isComplete && (tool.toolName.startsWith("request") || tool.toolName.startsWith("select") || tool.toolName === "getStudentTranscript" || tool.toolName === "presentMajorOptions")) {
      return (
        <div className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-2 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 rounded-lg border border-emerald-100 dark:border-emerald-900/50">
          <CheckCircle2 size={14} />
          Form Submitted Successfully
        </div>
      );
    }
  }

  return (
    <div className="w-full mt-2 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 shadow-sm text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          {isComplete ? (
            <CheckCircle2 size={16} className="text-zinc-900 dark:text-zinc-100" />
          ) : (
            <Loader2 size={16} className="animate-spin text-zinc-500" />
          )}
          <span className="font-mono font-medium text-xs text-zinc-700 dark:text-zinc-300">
            {tool.toolName}
          </span>
        </div>
        {expanded ? <ChevronDown size={14} className="text-zinc-500" /> : <ChevronRight size={14} className="text-zinc-500" />}
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-t border-zinc-200 dark:border-zinc-800 p-4 font-mono text-xs text-zinc-600 dark:text-zinc-400 overflow-x-auto bg-white dark:bg-black"
          >
            <div className="mb-2">
              <span className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1 block">Arguments:</span>
              <pre>{JSON.stringify(tool.args, null, 2)}</pre>
            </div>
            {isComplete && (
              <div>
                <span className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1 block mt-4">Result:</span>
                <pre>{JSON.stringify(tool.result, null, 2)}</pre>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Generative UI Form Components

function PreferencesForm({ tool, addToolOutput, sendMessage, onTranscriptParsed }: { tool: any, addToolOutput: any, sendMessage: any, onTranscriptParsed?: (courses: any[]) => void }) {
  const [maxCredits, setMaxCredits] = useState(15);
  const [minCredits, setMinCredits] = useState(12);
  const [genEdStrategy, setGenEdStrategy] = useState<"prioritize" | "balance">("balance");
  const [studentType, setStudentType] = useState<"undergrad" | "honors" | "grad">("undergrad");

  // Transcript upload state
  const [showTranscript, setShowTranscript] = useState(false);
  const [uploadMode, setUploadMode] = useState<'pdf' | 'text'>('pdf');
  const [transcriptStatus, setTranscriptStatus] = useState<'idle' | 'parsing' | 'done' | 'error'>('idle');
  const [transcriptCourses, setTranscriptCourses] = useState<any[]>([]);
  const [transcriptGpa, setTranscriptGpa] = useState<number | null>(null);
  const [transcriptSummary, setTranscriptSummary] = useState('');
  const [transcriptError, setTranscriptError] = useState('');
  const [pastedText, setPastedText] = useState('');
  const [msgIndex, setMsgIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const parsingMessages = [
    'Reading your transcript...',
    'Analyzing course information with AI...',
    'Extracting course codes and credits...',
    'Processing grades and semesters...',
    'Almost done...',
  ];

  useEffect(() => {
    if (transcriptStatus !== 'parsing') return;
    const timer = setInterval(() => setMsgIndex(p => (p + 1) % parsingMessages.length), 5000);
    return () => clearInterval(timer);
  }, [transcriptStatus, parsingMessages.length]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type && file.type !== 'application/pdf') { setTranscriptError('Only PDF files are supported.'); return; }
    if (file.size > 10 * 1024 * 1024) { setTranscriptError('File must be less than 10MB.'); return; }
    void uploadTranscript(file);
    e.target.value = '';
  };

  const uploadTranscript = async (file: File) => {
    setTranscriptStatus('parsing');
    setTranscriptError('');
    setMsgIndex(0);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/transcript/parse', { method: 'POST', body: formData });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Parse failed'); }
      const result = await res.json();
      if (result.success && result.courseCount > 0) {
        setTranscriptCourses(result.courses);
        setTranscriptGpa(result.gpa);
        setTranscriptSummary(`Parsed ${result.courseCount} courses from ${result.termCount} semesters${result.gpa ? ` (GPA: ${result.gpa})` : ''}`);
        setTranscriptStatus('done');
      } else {
        throw new Error(result.error || 'No courses detected in the transcript.');
      }
    } catch (err: any) {
      setTranscriptError(err.message);
      setTranscriptStatus('error');
    }
  };

  const handleTextParse = async () => {
    if (pastedText.trim().length < 50) { setTranscriptError('Please paste at least 50 characters of transcript text.'); return; }
    setTranscriptStatus('parsing');
    setTranscriptError('');
    setMsgIndex(0);
    try {
      const res = await fetch('/api/transcript/parse?mode=text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: pastedText }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Parse failed'); }
      const result = await res.json();
      if (result.success && result.courseCount > 0) {
        setTranscriptCourses(result.courses);
        setTranscriptGpa(result.gpa);
        setTranscriptSummary(`Parsed ${result.courseCount} courses from ${result.termCount} semesters${result.gpa ? ` (GPA: ${result.gpa})` : ''}`);
        setTranscriptStatus('done');
      } else {
        throw new Error(result.error || 'No courses detected.');
      }
    } catch (err: any) {
      setTranscriptError(err.message);
      setTranscriptStatus('error');
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const output: any = { maxCredits, minCredits, genEdStrategy, studentType };
    if (transcriptCourses.length > 0) {
      output.transcriptCourses = transcriptCourses;
      output.transcriptGpa = transcriptGpa;
    }
    // Lift transcript courses to parent state (no sessionStorage needed)
    onTranscriptParsed?.(transcriptCourses);
    addToolOutput({ tool: tool.toolName, toolCallId: tool.toolCallId, output });
    sendMessage({ text: "[System: Preferences saved" + (transcriptCourses.length > 0 ? ` with ${transcriptCourses.length} transcript courses` : '') + ". Now call requestMajorSelection.]" });
  };

  return (
    <div className="mt-4 w-[400px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Plan Preferences</h3>
        <p className="text-xs text-zinc-500 mt-1">Set credit limits and optionally upload your transcript.</p>
      </div>
      <form onSubmit={handleSubmit} className="p-5 space-y-5">
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Min Credits</label>
          <input type="number" value={minCredits} onChange={(e) => setMinCredits(parseInt(e.target.value) || 0)}
            className="w-full rounded-xl border border-zinc-300 px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white transition-all shadow-sm" />
        </div>
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Max Credits</label>
          <input type="number" value={maxCredits} onChange={(e) => setMaxCredits(parseInt(e.target.value) || 0)}
            className="w-full rounded-xl border border-zinc-300 px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white transition-all shadow-sm" />
        </div>
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Gen Ed Strategy</label>
          <div className="flex bg-zinc-100 dark:bg-zinc-900 rounded-xl p-1">
            <button type="button" onClick={() => setGenEdStrategy("prioritize")}
              className={`flex-1 py-2 px-3 text-sm font-medium rounded-lg transition-all ${genEdStrategy === "prioritize" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}>
              Prioritize
            </button>
            <button type="button" onClick={() => setGenEdStrategy("balance")}
              className={`flex-1 py-2 px-3 text-sm font-medium rounded-lg transition-all ${genEdStrategy === "balance" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}>
              Balance
            </button>
          </div>
          <p className="text-[10px] text-zinc-500 leading-tight">
            {genEdStrategy === "prioritize" ? "Complete Gen Eds as early as possible." : "Spread Gen Eds evenly across semesters."}
          </p>
        </div>
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Student Type</label>
          <div className="flex bg-zinc-100 dark:bg-zinc-900 rounded-xl p-1">
            <button type="button" onClick={() => setStudentType("undergrad")}
              className={`flex-1 py-2 px-2 text-xs font-medium rounded-lg transition-all ${studentType === "undergrad" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}>
              Undergrad
            </button>
            <button type="button" onClick={() => setStudentType("honors")}
              className={`flex-1 py-2 px-2 text-xs font-medium rounded-lg transition-all ${studentType === "honors" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}>
              Honors
            </button>
            <button type="button" onClick={() => setStudentType("grad")}
              className={`flex-1 py-2 px-2 text-xs font-medium rounded-lg transition-all ${studentType === "grad" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}>
              Grad
            </button>
          </div>
        </div>

        {/* ── Transcript Upload Section ── */}
        <div className="border-t border-zinc-200 dark:border-zinc-800 pt-4">
          <button type="button" onClick={() => setShowTranscript(!showTranscript)}
            className="flex items-center justify-between w-full text-left">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Upload Transcript <span className="normal-case font-normal">(optional)</span>
            </span>
            <span className="text-xs text-zinc-400">{showTranscript ? '▲' : '▼'}</span>
          </button>

          {showTranscript && (
            <div className="mt-3 space-y-3">
              {/* Mode toggle */}
              <div className="flex gap-1 bg-zinc-100 dark:bg-zinc-900 rounded-xl p-1">
                <button type="button" onClick={() => setUploadMode('pdf')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-all ${uploadMode === 'pdf' ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100' : 'text-zinc-500'}`}>
                  Upload PDF
                </button>
                <button type="button" onClick={() => setUploadMode('text')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-all ${uploadMode === 'text' ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100' : 'text-zinc-500'}`}>
                  Paste Text
                </button>
              </div>

              {transcriptStatus === 'idle' || transcriptStatus === 'error' ? (
                uploadMode === 'pdf' ? (
                  <>
                    <div onClick={() => fileInputRef.current?.click()}
                      className="border-2 border-dashed border-zinc-300 dark:border-zinc-700 rounded-xl p-6 cursor-pointer hover:border-zinc-400 dark:hover:border-zinc-600 transition-all text-center">
                      <Upload size={24} className="mx-auto text-zinc-400 mb-2" />
                      <p className="text-xs text-zinc-600 dark:text-zinc-400">Click to upload transcript PDF</p>
                      <p className="text-[10px] text-zinc-400 mt-1">PDF only, max 10MB</p>
                    </div>
                    <input ref={fileInputRef} type="file" accept="application/pdf" onChange={handleFileSelect} className="hidden" />
                  </>
                ) : (
                  <div className="space-y-2">
                    <textarea value={pastedText} onChange={e => setPastedText(e.target.value)}
                      placeholder="Paste your transcript text here..."
                      className="w-full h-36 p-3 rounded-xl border border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 text-xs font-mono resize-none outline-none focus:ring-2 focus:ring-black dark:focus:ring-white" />
                    <button type="button" onClick={handleTextParse}
                      disabled={pastedText.trim().length < 50}
                      className="w-full py-2 rounded-xl bg-zinc-800 text-white text-xs font-medium hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed dark:bg-zinc-200 dark:text-black dark:hover:bg-zinc-300 transition-all">
                      Parse Transcript
                    </button>
                  </div>
                )
              ) : transcriptStatus === 'parsing' ? (
                <div className="flex items-center gap-2.5 py-4 justify-center">
                  <Loader2 size={16} className="animate-spin text-zinc-400" />
                  <span className="text-xs text-zinc-500">{parsingMessages[msgIndex]}</span>
                </div>
              ) : transcriptStatus === 'done' ? (
                <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">{transcriptSummary}</span>
                  </div>
                  <button type="button" onClick={() => { setTranscriptStatus('idle'); setTranscriptCourses([]); setTranscriptSummary(''); }}
                    className="text-[10px] text-emerald-600 dark:text-emerald-400 hover:underline">Upload a different transcript</button>
                </div>
              ) : null}

              {transcriptError && (
                <div className="rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 p-3">
                  <p className="text-xs text-red-600 dark:text-red-400">{transcriptError}</p>
                  {uploadMode === 'pdf' && (
                    <button type="button" onClick={() => { setUploadMode('text'); setTranscriptError(''); setTranscriptStatus('idle'); }}
                      className="text-[10px] text-red-500 hover:underline mt-1">Try pasting text instead →</button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <button type="submit" disabled={transcriptStatus === 'parsing'}
          className="w-full rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] dark:bg-white dark:text-black mt-2 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">
          {transcriptStatus === 'parsing' ? 'Parsing transcript...' : 'Save Preferences'}
        </button>
      </form>
    </div>
  );
}

function ProgramSelectionForm({ tool, addToolOutput, type, sendMessage }: { tool: any, addToolOutput: any, type: string, sendMessage: any }) {
  const [selected, setSelected] = useState("");

  // Dummy options for the MVP, in the future this should come from tool execution querying a database
  const options = type === "Major"
    ? ["Information Systems (BSIS)", "Computer Science (BS)"]
    : type === "Minor"
      ? ["None", "Mathematics (Minor)", "Entrepreneurship (Minor)"]
      : ["BYU Gen Ed & Religion (2024)", "Standard Gen Ed"];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    addToolOutput({
      tool: tool.toolName,
      toolCallId: tool.toolCallId,
      output: { selectedProgram: selected }
    });
    sendMessage({ text: "[System: Form submitted successfully. Please proceed to the next step.]" });
  };

  return (
    <div className="mt-4 w-[350px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Select {type}</h3>
        <p className="text-xs text-zinc-500 mt-1">Choose a program for your plan.</p>
      </div>
      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        <div className="space-y-3">
          {options.map((opt) => (
            <label key={opt} className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${selected === opt ? 'border-black bg-zinc-50 dark:border-white dark:bg-zinc-900' : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'}`}>
              <input
                type="radio"
                name="program"
                value={opt}
                checked={selected === opt}
                onChange={() => setSelected(opt)}
                className="w-4 h-4 accent-black dark:accent-white"
              />
              <span className="text-sm font-medium">{opt}</span>
            </label>
          ))}
        </div>
        <button
          type="submit"
          disabled={!selected}
          className="w-full rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed dark:bg-white dark:text-black mt-2 shadow-sm"
        >
          Confirm {type}
        </button>
      </form>
    </div>
  );
}

function TranscriptUploadForm({ tool, addToolOutput, sendMessage }: { tool: any, addToolOutput: any, sendMessage: any }) {
  const [file, setFile] = useState<File | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    // MVP Mock implementation: Instead of parsing, we simply return a predefined
    // dummy JSON object that the AI can pretend to read. In the future this 
    // will read the JSON file directly. 
    addToolOutput({
      tool: tool.toolName,
      toolCallId: tool.toolCallId,
      output: {
        transcriptUploaded: true,
        fileName: file.name,
        // Provided fake course data for the scaffold logic to consume
        completedCourses: ["IS 201", "CS 142", "MATH 112"]
      }
    });
    sendMessage({ text: "[System: Form submitted successfully. Please proceed to the next step.]" });
  };

  return (
    <div className="mt-4 w-[350px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Upload Transcript</h3>
        <p className="text-xs text-zinc-500 mt-1">Please provide your completed courses history as a JSON file.</p>
      </div>
      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        <div className="space-y-3">
          <input
            type="file"
            accept=".json"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="block w-full text-sm text-zinc-500 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-medium file:bg-zinc-100 file:text-zinc-700 hover:file:bg-zinc-200 dark:file:bg-zinc-800 dark:file:text-zinc-300 dark:hover:file:bg-zinc-700 transition-all cursor-pointer"
          />
        </div>
        <button
          type="submit"
          disabled={!file}
          className="w-full rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed dark:bg-white dark:text-black mt-2 shadow-sm"
        >
          Confirm Upload
        </button>
      </form>
    </div>
  );
}

function PlanReviewForm({ tool, addToolOutput, sendMessage, liveJson }: { tool: any, addToolOutput: any, sendMessage: any, liveJson: any }) {
  const [feedback, setFeedback] = useState("");
  const [isIterating, setIsIterating] = useState(false);

  const handleDownload = () => {
    if (!liveJson) return;
    const blob = new Blob([JSON.stringify(liveJson, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "grad-plan.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    addToolOutput({
      tool: tool.toolName,
      toolCallId: tool.toolCallId,
      output: { action: "downloaded", message: "User downloaded the plan." }
    });
    sendMessage({ text: "[System: The user downloaded the plan. You can ask if they need anything else, or conclude the conversation.]" });
  };

  const handleIterate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedback.trim()) return;

    addToolOutput({
      tool: tool.toolName,
      toolCallId: tool.toolCallId,
      output: { action: "iterating", feedback }
    });
    sendMessage({ text: `[System: The user wants to iterate. Feedback provided: "${feedback}". Please determine the next step.]` });
  };

  return (
    <div className="mt-4 w-[350px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Plan Generated!</h3>
        <p className="text-xs text-zinc-500 mt-1">Review your generated Grad Plan. Is it good to go?</p>
      </div>

      <div className="p-5 space-y-4">
        {!isIterating ? (
          <div className="space-y-3">
            <button
              onClick={handleDownload}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] dark:bg-white dark:text-black shadow-sm"
            >
              Download Plan JSON
            </button>
            <button
              onClick={() => setIsIterating(true)}
              className="w-full rounded-xl bg-zinc-100 py-3 text-sm font-medium text-zinc-900 transition-transform hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
            >
              Continue Iterating
            </button>
          </div>
        ) : (
          <form onSubmit={handleIterate} className="space-y-3">
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">How can we improve it?</label>
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                rows={3}
                placeholder="E.g., Move CS 142 to Fall 2027 instead..."
                className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white transition-all shadow-sm resize-none"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setIsIterating(false)}
                className="w-1/3 rounded-xl bg-zinc-100 py-3 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={!feedback.trim()}
                className="flex-1 rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed dark:bg-white dark:text-black shadow-sm"
              >
                Send Feedback
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}


// ─── MinorSelectionForm ────────────────────────────────────────────────
// Mirrors MajorSelectionForm but for minors. Offers autocomplete search
// from the DB plus a "Skip / No Minor" escape hatch.
function MinorSelectionForm({ tool, addToolOutput, sendMessage }: { tool: any, addToolOutput: any, sendMessage: any }) {
  const [query, setQuery] = useState("");
  const [programs, setPrograms] = useState<{ name: string }[]>([]);
  const [filtered, setFiltered] = useState<{ name: string }[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  const fetchPrograms = async () => {
    if (fetched) return;
    setLoading(true);
    try {
      const res = await fetch("/api/programs?type=minor");
      const data = await res.json();
      setPrograms(data.programs ?? []);
      setFiltered(data.programs ?? []);
    } finally {
      setLoading(false);
      setFetched(true);
    }
  };

  const handleSearch = (val: string) => {
    setQuery(val);
    setSelected("");
    setFiltered(programs.filter(p => p.name.toLowerCase().includes(val.toLowerCase())));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    addToolOutput({ tool: tool.toolName, toolCallId: tool.toolCallId, output: { selectedProgram: selected } });
    sendMessage({ text: "[System: Minor confirmed. Now immediately call selectMinorCourses with programName='" + selected + "' \u2014 do not ask the user, just invoke the tool.]" });
  };

  const handleSkip = () => {
    addToolOutput({ tool: tool.toolName, toolCallId: tool.toolCallId, output: { selectedProgram: null, skipped: true } });
    sendMessage({ text: "[System: User chose not to add a minor. Now immediately call selectGenEdCourses \u2014 do not ask the user, just invoke the tool.]" });
  };

  return (
    <div className="mt-4 w-[380px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Select a Minor</h3>
        <p className="text-xs text-zinc-500 mt-1">Search for a minor below, or skip if you don't want one.</p>
      </div>

      <div className="p-5 space-y-4">
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Search Minors</label>
            <input
              type="text"
              placeholder="e.g. Mathematics, Entrepreneurship..."
              value={query}
              onFocus={fetchPrograms}
              onChange={(e) => handleSearch(e.target.value)}
              className="w-full rounded-xl border border-zinc-300 px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white transition-all shadow-sm"
            />
            {loading && <p className="text-xs text-zinc-400 px-1">Loading minors...</p>}
          </div>

          {fetched && filtered.length > 0 && (
            <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
              {filtered.map((p) => (
                <label
                  key={p.name}
                  className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all text-sm ${selected === p.name
                    ? "border-black bg-zinc-50 dark:border-white dark:bg-zinc-900"
                    : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
                    }`}
                >
                  <input
                    type="radio"
                    name="minor"
                    value={p.name}
                    checked={selected === p.name}
                    onChange={() => setSelected(p.name)}
                    className="w-4 h-4 accent-black dark:accent-white shrink-0"
                  />
                  <span className="font-medium">{p.name}</span>
                </label>
              ))}
            </div>
          )}
          {fetched && filtered.length === 0 && query && (
            <p className="text-xs text-zinc-400 px-1">No minors match your search.</p>
          )}

          <button
            type="submit"
            disabled={!selected}
            className="w-full rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed dark:bg-white dark:text-black shadow-sm"
          >
            Confirm Minor
          </button>
        </form>

        <div className="relative flex items-center">
          <div className="flex-1 border-t border-zinc-200 dark:border-zinc-800" />
          <span className="mx-3 text-xs text-zinc-400">or</span>
          <div className="flex-1 border-t border-zinc-200 dark:border-zinc-800" />
        </div>

        <button
          type="button"
          onClick={handleSkip}
          className="w-full rounded-xl bg-zinc-100 py-3 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          Skip — No Minor
        </button>
      </div>
    </div>
  );
}

// ─── MajorOptionsForm ──────────────────────────────────────────────────
// Renders the 3 AI-recommended majors with reasoning as labeled radio buttons
function MajorOptionsForm({ tool, addToolOutput, sendMessage }: { tool: any, addToolOutput: any, sendMessage: any }) {
  const [selected, setSelected] = useState("");
  const options: { name: string; reason: string }[] = tool.args?.options ?? [];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    addToolOutput({ tool: tool.toolName, toolCallId: tool.toolCallId, output: { selectedProgram: selected } });
    sendMessage({ text: "[System: Form submitted successfully. Please proceed to the next step.]" });
  };

  return (
    <div className="mt-4 w-[380px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Recommended Majors</h3>
        <p className="text-xs text-zinc-500 mt-1">Based on your answers, here are 3 programs that fit you best.</p>
      </div>
      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        {options.length === 0 ? (
          <p className="text-sm text-zinc-400">Loading recommendations...</p>
        ) : (
          <div className="space-y-3">
            {options.map((opt) => (
              <label
                key={opt.name}
                className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-all ${selected === opt.name
                  ? "border-black bg-zinc-50 dark:border-white dark:bg-zinc-900"
                  : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
                  }`}
              >
                <input
                  type="radio"
                  name="recommended-major"
                  value={opt.name}
                  checked={selected === opt.name}
                  onChange={() => setSelected(opt.name)}
                  className="mt-0.5 w-4 h-4 accent-black dark:accent-white shrink-0"
                />
                <div>
                  <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100">{opt.name}</span>
                  <span className="block text-xs text-zinc-500 mt-1 leading-relaxed">{opt.reason}</span>
                </div>
              </label>
            ))}
          </div>
        )}
        <button
          type="submit"
          disabled={!selected}
          className="w-full rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed dark:bg-white dark:text-black shadow-sm"
        >
          Confirm Major
        </button>
      </form>
    </div>
  );
}

// ─── CareerQuestionnaireForm ───────────────────────────────────────────
const CAREER_QUESTIONS = [
  { id: "q1", label: "What is something you are naturally good at?", placeholder: "e.g. problem-solving, communicating with people, writing..." },
  { id: "q2", label: "Do you prefer deep technical work or social-facing roles?", placeholder: "e.g. I love coding and building systems, or I thrive working with clients..." },
  { id: "q3", label: "How much do you value flexibility and remote work?", placeholder: "e.g. Very important — I want to work anywhere, or I prefer an office..." },
  { id: "q4", label: "Do you prefer solving new, complex problems or following a structured routine?", placeholder: "e.g. I love tackling open-ended challenges..." },
  { id: "q5", label: "Is high earning potential your primary motivator, or is work-life balance more important?", placeholder: "e.g. Earnings matter most to me right now, or balance and purpose..." },
  { id: "q6", label: "Describe the type of impact you'd like your career to have:", placeholder: "e.g. Build products used by millions, help individuals in my community..." },
];

function CareerQuestionnaireForm({ tool, addToolOutput, sendMessage }: { tool: any, addToolOutput: any, sendMessage: any }) {
  const [answers, setAnswers] = useState<Record<string, string>>(
    Object.fromEntries(CAREER_QUESTIONS.map(q => [q.id, ""]))
  );

  const allAnswered = CAREER_QUESTIONS.every(q => answers[q.id].trim().length > 0);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!allAnswered) return;

    // Build a structured summary for the AI / queryPrograms tool
    const userContext = CAREER_QUESTIONS.map(q => `${q.label}\n${answers[q.id].trim()}`).join("\n\n");

    addToolOutput({
      tool: tool.toolName,
      toolCallId: tool.toolCallId,
      output: {
        answers: CAREER_QUESTIONS.map(q => ({ question: q.label, answer: answers[q.id].trim() })),
        userContext,
      }
    });
    sendMessage({ text: "[System: Career questionnaire submitted. Please call queryPrograms with the userContext from the tool result, then presentMajorOptions with the top 3.]" });
  };

  return (
    <div className="mt-4 w-[400px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Career Discovery</h3>
        <p className="text-xs text-zinc-500 mt-1">Answer all 6 questions to help us find the best major for you.</p>
      </div>
      <form onSubmit={handleSubmit} className="p-5 space-y-5">
        {CAREER_QUESTIONS.map((q, i) => (
          <div key={q.id} className="space-y-1.5">
            <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 text-[10px] font-bold mr-1.5">{i + 1}</span>
              {q.label}
            </label>
            <textarea
              rows={2}
              value={answers[q.id]}
              onChange={(e) => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
              placeholder={q.placeholder}
              className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3.5 py-2.5 text-sm outline-none focus:ring-2 focus:ring-black dark:focus:ring-white transition-all shadow-sm resize-none leading-relaxed placeholder:text-zinc-400"
            />
          </div>
        ))}
        <button
          type="submit"
          disabled={!allAnswered}
          className="w-full rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed dark:bg-white dark:text-black shadow-sm"
        >
          {allAnswered ? "Find My Major" : `Answer all ${CAREER_QUESTIONS.filter(q => !answers[q.id].trim()).length} remaining questions`}
        </button>
      </form>
    </div>
  );
}

// Module-level map so the completed state survives component remounts caused by re-renders
const queryProgramsSelections = new Map<string, string>(); // toolCallId -> selectedMajor

// ─── QueryProgramsOptionsForm ──────────────────────────────────────────
// Renders the recommendedPrograms returned by queryPrograms.execute directly,
// bypassing the need for the AI to chain a second presentMajorOptions call.
function QueryProgramsOptionsForm({ tool, addToolOutput, sendMessage }: { tool: any, addToolOutput: any, sendMessage: any }) {
  const alreadySelected = queryProgramsSelections.get(tool.toolCallId);
  const [selected, setSelected] = useState(alreadySelected ?? "");
  const options: { name: string; reason: string }[] = tool.result?.recommendedPrograms ?? [];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || alreadySelected) return;
    queryProgramsSelections.set(tool.toolCallId, selected);
    // Report back so the AI knows to proceed to the next step
    sendMessage({ text: `[System: User selected major: ${selected}. Please proceed to the next step.]` });
  };

  if (alreadySelected) {
    return (
      <div className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-2 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 rounded-lg border border-emerald-100 dark:border-emerald-900/50">
        <CheckCircle2 size={14} />
        Major selected: {alreadySelected}
      </div>
    );
  }

  return (
    <div className="mt-4 w-[400px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Recommended Majors</h3>
        <p className="text-xs text-zinc-500 mt-1">Based on your answers, here are your top 3 matches.</p>
      </div>
      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        <div className="space-y-3">
          {options.map((opt) => (
            <label
              key={opt.name}
              className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-all ${selected === opt.name
                ? "border-black bg-zinc-50 dark:border-white dark:bg-zinc-900"
                : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
                }`}
            >
              <input
                type="radio"
                name="recommended-major"
                value={opt.name}
                checked={selected === opt.name}
                onChange={() => setSelected(opt.name)}
                className="mt-0.5 w-4 h-4 accent-black dark:accent-white shrink-0"
              />
              <div>
                <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100">{opt.name}</span>
                <span className="block text-xs text-zinc-500 mt-1 leading-relaxed">{opt.reason}</span>
              </div>
            </label>
          ))}
        </div>
        <button
          type="submit"
          disabled={!selected}
          className="w-full rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed dark:bg-white dark:text-black shadow-sm"
        >
          Confirm Major
        </button>
      </form>
    </div>
  );
}

// ─── GenEdSelectionForm ────────────────────────────────────────────────
// 1. Asks which catalog year applies (2024+ or pre-2024)
// 2. Loads the corresponding JSON from /api/gen-ed
// 3. Shows each GE area as an accordion with a searchable course picker
type GenEdCourse = { code: string | null; title: string | null; credits: number | { min: number; max: number } | null; status: string; notes?: string[] };
type GenEdSubReq = { requirementId?: string; description: string; courses?: GenEdCourse[]; subRequirements?: GenEdSubReq[] };
type GenEdReq = { description: string; requirementId: number | string; description_rule?: string; notes?: string[]; courses?: GenEdCourse[]; subRequirements?: GenEdSubReq[] };

function flattenActiveCourses(req: GenEdReq | GenEdSubReq): GenEdCourse[] {
  const out: GenEdCourse[] = [];
  if ('courses' in req && req.courses) out.push(...req.courses.filter(c => c.code && c.status === 'active'));
  if ('subRequirements' in req && req.subRequirements) {
    for (const sub of req.subRequirements) out.push(...flattenActiveCourses(sub));
  }
  return out;
}

function fmtCredits(credits: GenEdCourse['credits']): string {
  if (!credits) return '';
  if (typeof credits === 'number') return `${credits} cr`;
  return `${credits.min}–${credits.max} cr`;
}

function GenEdSelectionForm({ tool, addToolOutput, sendMessage, transcriptCourses }: { tool: any; addToolOutput: any; sendMessage: any; transcriptCourses: any[] }) {
  const [year, setYear] = useState<'2024' | 'pre-2024' | null>(null);
  const [requirements, setRequirements] = useState<GenEdReq[]>([]);
  const [loading, setLoading] = useState(false);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [courseQuery, setCourseQuery] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const transcriptCodes = useMemo(
    () => new Set(transcriptCourses.map((c: any) => `${c.subject}${c.number}`.replace(/\s+/g, '').toUpperCase())),
    [transcriptCourses]
  );
  function normCode(code: string): string {
    return code.replace(/\s+/g, '').toUpperCase();
  }
  function isCourseCompleted(code: string): boolean {
    return transcriptCodes.has(normCode(code));
  }
  function parseRequiredCount(rule: string | undefined): number {
    if (!rule) return 1;
    let m = rule.match(/Complete\s+(\d+)\s+of\s+(\d+)/i);
    if (m) return parseInt(m[1]);
    m = rule.match(/Complete\s+(\d+)\s+Course/i);
    if (m) return parseInt(m[1]);
    return 1;
  }

  const loadRequirements = async (y: '2024' | 'pre-2024') => {
    setLoading(true);
    try {
      const res = await fetch(`/api/gen-ed?year=${y}`);
      const data = await res.json();
      const reqs: GenEdReq[] = data.programRequirements ?? [];
      setRequirements(reqs);

      const autoSelections: Record<string, string[]> = {};
      for (let i = 0; i < reqs.length; i++) {
        const req = reqs[i];
        const id = `${req.requirementId}-${i}`;
        const allCourses = flattenActiveCourses(req);
        const reqCount = parseRequiredCount(req.description_rule);
        const sel: string[] = [];

        // Add from transcript
        for (const c of allCourses) {
          if (c.code && isCourseCompleted(c.code) && sel.length < reqCount && !sel.includes(c.code)) {
            sel.push(c.code);
          }
        }
        // Auto-select if choices == required
        if (sel.length < reqCount && allCourses.length > 0 && allCourses.length <= reqCount) {
          for (const c of allCourses) {
            if (c.code && sel.length < reqCount && !sel.includes(c.code)) sel.push(c.code);
          }
        }
        if (sel.length > 0) autoSelections[id] = sel;
      }
      setSelections(prev => ({ ...prev, ...autoSelections }));

      if (reqs.length > 0) setExpanded({ [`${reqs[0].requirementId}-0`]: true });
    } finally {
      setLoading(false);
    }
  };

  const handleYearSelect = (y: '2024' | 'pre-2024') => { setYear(y); loadRequirements(y); };
  const toggleExpand = (id: string | number) => setExpanded(prev => ({ ...prev, [String(id)]: !prev[String(id)] }));

  const handleSelect = (id: string, code: string) => {
    const sId = id;
    const reqIndex = parseInt(sId.split('-').pop()!);
    const req = requirements[reqIndex];
    const reqCount = parseRequiredCount(req?.description_rule);

    setSelections(prev => {
      const current = prev[sId] || [];
      if (current.includes(code)) {
        return { ...prev, [sId]: current.filter(c => c !== code) };
      }
      if (current.length >= reqCount) {
        return { ...prev, [sId]: [...current.slice(1), code] };
      }
      return { ...prev, [sId]: [...current, code] };
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (submitted) return;
    setSubmitted(true);

    // Build gen ed courses for scaffold
    const genEdCourses: any[] = [];
    for (let i = 0; i < requirements.length; i++) {
      const req = requirements[i];
      const codes = selections[`${req.requirementId}-${i}`] || [];
      for (const code of codes) {
        const allCourses = flattenActiveCourses(req);
        const course = allCourses.find(c => c.code === code);
        if (course) {
          genEdCourses.push({
            code: course.code,
            title: course.title,
            credits: typeof course.credits === 'number' ? course.credits : (course.credits?.min ?? 3),
            source: 'genEd',
            requirementId: String(req.requirementId),
            requirementDescription: req.description,
          });
        }
      }
    }

    // Fire async scaffold
    const planId = (typeof window !== 'undefined' && sessionStorage.getItem('gradPlanId')) || crypto.randomUUID();
    if (typeof window !== 'undefined') sessionStorage.setItem('gradPlanId', planId);
    fetch('/api/scaffold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId, phase: 'genEd', courses: genEdCourses }) }).catch(console.error);

    addToolOutput({ tool: tool.toolName, toolCallId: tool.toolCallId, output: { catalogYear: year, genEdSelections: selections } });
    sendMessage({ text: '[System: Gen Ed course selections submitted. Now immediately call getStudentTranscript - do not ask the user, just invoke the tool.]' });
  };

  const filledCount = Object.values(selections).flat().length;

  if (submitted) {
    return (
      <div className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-2 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 rounded-lg border border-emerald-100 dark:border-emerald-900/50">
        <CheckCircle2 size={14} />
        Gen Ed selections submitted ({filledCount} course{filledCount !== 1 ? 's' : ''} planned, {year} catalog)
      </div>
    );
  }

  // Step 1: pick catalog year
  if (!year) {
    return (
      <div className="mt-4 w-[400px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
        <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
          <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">GE Catalog Year</h3>
          <p className="text-xs text-zinc-500 mt-1">Which set of GE requirements applies to you?</p>
        </div>
        <div className="p-5 space-y-3">
          {([
            { year: '2024', label: '2024 and later catalog', desc: 'For students admitted as a freshman for Winter 2024 or after.' },
            { year: 'pre-2024', label: 'Pre-2024 catalog', desc: 'For students admitted as a freshman before Winter 2024 or as a transfer student.' },
          ] as const).map(({ year: y, label, desc }) => (
            <button key={y} type="button" onClick={() => handleYearSelect(y)}
              className="w-full rounded-xl border border-zinc-200 px-4 py-3 text-left transition-all hover:border-black hover:bg-zinc-50 dark:border-zinc-800 dark:hover:border-white dark:hover:bg-zinc-900">
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{label}</div>
              <div className="text-xs text-zinc-500 mt-0.5">{desc}</div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="mt-4 w-[400px] rounded-2xl border border-zinc-200 dark:border-zinc-800 px-5 py-6 text-sm text-zinc-400">Loading GE requirements…</div>;
  }

  return (
    <div className="mt-4 w-[460px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Plan Your GE Courses</h3>
        <p className="text-xs text-zinc-500 mt-1">
          {year === 'pre-2024' ? 'Pre-2024' : '2024+'} catalog · {filledCount} courses selected
        </p>
        <div className="mt-2 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div className="h-1.5 rounded-full bg-black dark:bg-white transition-all"
            style={{ width: `${requirements.length > 0 ? Math.min(100, (filledCount / requirements.length) * 100) : 0}%` }} />
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="max-h-[480px] overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800">
          {requirements.map((req, index) => {
            const id = `${req.requirementId}-${index}`;
            const isOpen = !!expanded[id];
            const allCourses = flattenActiveCourses(req);
            const currentSelections = selections[id] || [];
            const reqCount = parseRequiredCount(req.description_rule);
            const isReqMet = currentSelections.length >= reqCount;
            const q = courseQuery[id] ?? '';
            const visible = q
              ? allCourses.filter(c => (c.code ?? '').toLowerCase().includes(q.toLowerCase()) || (c.title ?? '').toLowerCase().includes(q.toLowerCase()))
              : allCourses;

            return (
              <div key={id}>
                <button type="button" onClick={() => toggleExpand(id)}
                  className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${isReqMet ? 'border-emerald-500 bg-emerald-500 text-white' : currentSelections.length > 0 ? 'border-black bg-black dark:border-white dark:bg-white text-white dark:text-black' : 'border-zinc-300 dark:border-zinc-700'}`}>
                      {(isReqMet || currentSelections.length > 0) && <CheckCircle2 size={12} strokeWidth={3} />}
                    </div>
                    <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">{req.description}</span>
                    {req.description_rule && <span className="text-xs text-zinc-400 shrink-0">({req.description_rule})</span>}
                  </div>
                  <span className="text-zinc-400 text-xs ml-2">{isOpen ? '▲' : '▼'}</span>
                </button>

                {isOpen && (
                  <div className="px-5 pb-4 space-y-2">
                    {req.notes?.map((n, i) => <p key={i} className="text-xs text-zinc-500 italic">{n}</p>)}

                    {allCourses.length > 6 && (
                      <input type="text" placeholder="Search courses…" value={q}
                        onChange={e => setCourseQuery(prev => ({ ...prev, [id]: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white" />
                    )}

                    {allCourses.length === 0 && (
                      <p className="text-xs text-zinc-400">No specific courses listed — see your academic catalog or advisor.</p>
                    )}

                    {visible.length === 0 && q && (
                      <p className="text-xs text-zinc-400">No courses match "{q}".</p>
                    )}

                    <div className="space-y-1 max-h-52 overflow-y-auto pr-1">
                      {visible.map(course => {
                        const isCompleted = course.code ? isCourseCompleted(course.code) : false;
                        const isSelected = course.code ? currentSelections.includes(course.code) : false;

                        return (
                          <label key={`${id}-${course.code}`}
                            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs ${isSelected ? 'border-black bg-zinc-50 dark:border-white dark:bg-zinc-900' : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'}`}>
                            {reqCount === 1 ? (
                              <input type="radio" name={`req-${id}`} value={course.code ?? ''}
                                checked={isSelected}
                                onChange={() => handleSelect(id, course.code!)}
                                className="w-3.5 h-3.5 accent-black dark:accent-white shrink-0" />
                            ) : (
                              <div className={`w-3.5 h-3.5 shrink-0 rounded border flex items-center justify-center transition-colors ${isSelected ? 'bg-black border-black text-white dark:bg-white dark:border-white dark:text-black' : 'border-zinc-300 dark:border-zinc-600'}`}>
                                {isSelected && <CheckCircle2 size={10} strokeWidth={4} />}
                              </div>
                            )}
                            <input type="checkbox" className="hidden" aria-hidden checked={isSelected} onChange={() => handleSelect(id, course.code!)} />

                            <span className="font-mono text-zinc-400 shrink-0">{course.code}</span>
                            <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">{course.title}</span>

                            {isCompleted && (
                              <span className="ml-auto flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                                Transferred
                              </span>
                            )}

                            {course.credits != null && !isCompleted && (
                              <span className="ml-auto text-zinc-400 shrink-0">{fmtCredits(course.credits)}</span>
                            )}
                          </label>
                        );
                      })}
                    </div>

                    {currentSelections.length > 0 && (
                      <button type="button" onClick={() => setSelections(prev => ({ ...prev, [id]: [] }))}
                        className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 underline">
                        Clear selection
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {(() => {
          const unsatisfiedCount = requirements.reduce((n, req, i) => {
            const currentSelections = selections[`${req.requirementId}-${i}`] || [];
            const reqCount = parseRequiredCount(req.description_rule);
            if (currentSelections.length < reqCount) return n + 1;
            return n;
          }, 0);
          const isFormComplete = requirements.length > 0 && unsatisfiedCount === 0;

          return (
            <div className="border-t border-zinc-200 dark:border-zinc-800 px-5 py-4 space-y-2">
              <button type="submit"
                disabled={!isFormComplete}
                className={`w-full rounded-xl py-3 text-sm font-medium transition-all shadow-sm ${isFormComplete
                  ? 'bg-black text-white dark:bg-white dark:text-black hover:scale-[1.02]'
                  : 'bg-zinc-200 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-600 cursor-not-allowed'
                  }`}>
                {isFormComplete
                  ? `Submit ${filledCount} Course${filledCount !== 1 ? 's' : ''}`
                  : `${unsatisfiedCount} requirement${unsatisfiedCount !== 1 ? 's' : ''} left to fill`}
              </button>

              <button
                type="button"
                onClick={() => {
                  setSubmitted(true);
                  addToolOutput({ tool: tool.toolName, toolCallId: tool.toolCallId, output: { action: "skipped" } });
                  sendMessage({ text: `[System: User chose to skip selecting Gen Ed courses. Check with them on how they want to proceed.]` });
                }}
                className="w-full rounded-xl py-3 text-sm font-medium transition-all text-zinc-500 hover:text-black dark:text-zinc-400 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Skip / Choose Something Else
              </button>
            </div>
          );
        })()
        }
      </form >
    </div >
  );
}

// ─── ProgramCourseSelectionForm ─────────────────────────────────────────
// Per-requirement course picker for major or minor programs.
interface ProgramReq {
  requirementId: number | string;
  description: string;
  notes?: string;
  courses?: { code: string; title: string; credits: number; prerequisite?: string; status?: string }[];
  subRequirements?: {
    requirementId: string;
    description: string;
    courses: { code: string; title: string; credits: number; prerequisite?: string; status?: string }[];
  }[];
  otherRequirement?: string;
}

function ProgramCourseSelectionForm({ tool, addToolOutput, sendMessage, type, transcriptCourses: transcriptCoursesProp }: { tool: any; addToolOutput: any; sendMessage: any; type: 'major' | 'minor'; transcriptCourses: any[] }) {
  const programName: string = tool.args?.programName ?? '';
  const [requirements, setRequirements] = useState<ProgramReq[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Multi-select: selections is now Record<slotId, string[]> instead of Record<slotId, string>
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [searchQ, setSearchQ] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  // Derive normalized transcript codes directly from prop — no storage needed
  const transcriptCodes = useMemo(
    () => new Set(transcriptCoursesProp.map((c: any) => `${c.subject}${c.number}`.replace(/\s+/g, '').toUpperCase())),
    [transcriptCoursesProp]
  );

  // Debounce programName so we only fetch once the AI has finished streaming the full name
  const [stableProgramName, setStableProgramName] = useState('');
  useEffect(() => {
    if (!programName) return;
    const timer = setTimeout(() => setStableProgramName(programName), 300);
    return () => clearTimeout(timer);
  }, [programName]);

  function parseSlotInfo(desc: string, courseCount: number): { required: number; total: number } {
    // "Complete 1 of 3 Courses"
    const xOfY = desc.match(/Complete\s+(\d+)\s+of\s+(\d+)\s+Course/i);
    if (xOfY) return { required: parseInt(xOfY[1]), total: parseInt(xOfY[2]) };
    // "Complete 6 Courses"
    const nCourses = desc.match(/Complete\s+(\d+)\s+Course/i);
    if (nCourses) return { required: parseInt(nCourses[1]), total: courseCount };
    // fallback
    return { required: 1, total: courseCount };
  }

  function normCode(code: string): string {
    return code.replace(/\s+/g, '').toUpperCase();
  }

  // Helper: check if a course code appears in transcript
  function isCourseCompleted(code: string): boolean {
    return transcriptCodes.has(normCode(code));
  }

  useEffect(() => {
    if (!stableProgramName) return;
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    (async () => {
      try {
        const res = await fetch(`/api/program-requirements?program=${encodeURIComponent(stableProgramName)}&type=${type}`);
        if (cancelled) return;
        if (!res.ok) throw new Error('Failed to load requirements');
        const data = await res.json();
        const reqs: ProgramReq[] = data.programRequirements ?? [];
        setRequirements(reqs);
        if (reqs.length > 0) setExpandedIds({ [String(reqs[0].requirementId)]: true });

        // Auto-select courses: when required == available OR course is from transcript
        const autoSelections: Record<string, string[]> = {};
        for (const req of reqs) {
          for (const slot of getSlots(req)) {
            const activeCourses = slot.courses.filter(c => !c.status || c.status === 'active');
            const info = parseSlotInfo(slot.label, activeCourses.length);

            // Check transcript matches for this slot
            const transcriptMatches = activeCourses.filter(c => transcriptCodes.has(normCode(c.code)));

            if (info.required === activeCourses.length) {
              // Must take all — auto-select all
              autoSelections[slot.id] = activeCourses.map(c => c.code);
            } else if (transcriptMatches.length >= info.required) {
              // Transcript fulfills entire requirement
              autoSelections[slot.id] = transcriptMatches.slice(0, info.required).map(c => c.code);
            } else if (transcriptMatches.length > 0) {
              // Partial transcript matches
              autoSelections[slot.id] = transcriptMatches.map(c => c.code);
            }
          }
        }
        if (Object.keys(autoSelections).length > 0 && !cancelled) {
          setSelections(autoSelections);
        }
      } catch (e: any) {
        if (!cancelled) setFetchError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableProgramName, transcriptCodes]);

  function getSlots(req: ProgramReq) {
    const slots: { id: string; label: string; courses: NonNullable<ProgramReq['courses']> }[] = [];
    if (req.courses?.length) slots.push({ id: String(req.requirementId), label: req.description, courses: req.courses });
    if (req.subRequirements) {
      for (const sub of req.subRequirements) {
        if (sub.courses?.length) slots.push({ id: sub.requirementId, label: sub.description, courses: sub.courses });
      }
    }
    return slots;
  }

  function toggleCourse(slotId: string, code: string, maxSelect: number) {
    setSelections(prev => {
      const current = prev[slotId] ?? [];
      if (current.includes(code)) {
        return { ...prev, [slotId]: current.filter(c => c !== code) };
      }
      if (current.length >= maxSelect) {
        // Replace oldest selection
        return { ...prev, [slotId]: [...current.slice(1), code] };
      }
      return { ...prev, [slotId]: [...current, code] };
    });
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitted) return;
    setSubmitted(true);

    const selectedCourses: any[] = [];
    for (const req of requirements) {
      for (const slot of getSlots(req)) {
        const codes = selections[slot.id] ?? [];
        for (const code of codes) {
          const c = slot.courses.find(x => x.code === code);
          if (c) selectedCourses.push({ ...c, source: type, requirementId: slot.id, requirementDescription: slot.label, fromTranscript: isCourseCompleted(c.code) });
        }
      }
    }

    // Fire async scaffold
    const planId = (typeof window !== 'undefined' && sessionStorage.getItem('gradPlanId')) || crypto.randomUUID();
    if (typeof window !== 'undefined') sessionStorage.setItem('gradPlanId', planId);
    fetch('/api/scaffold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId, phase: type, courses: selectedCourses }) }).catch(console.error);

    addToolOutput({ tool: tool.toolName, toolCallId: tool.toolCallId, output: { programName, selectedCourses, courseCount: selectedCourses.length } });

    const next = type === 'major'
      ? "[System: Major course selections submitted. Now immediately call requestMinorSelection - do not ask the user, just invoke the tool.]"
      : "[System: Minor course selections submitted. Now immediately call selectGenEdCourses - do not ask the user, just invoke the tool.]";
    sendMessage({ text: next });
  };

  const filledCount = Object.values(selections).flat().filter(Boolean).length;
  const totalSlots = requirements.reduce((n, r) => n + getSlots(r).length, 0);

  // Compute whether every slot has met its required course count
  const unsatisfiedCount = requirements.reduce((n, req) => {
    for (const slot of getSlots(req)) {
      const activeCourses = slot.courses.filter(c => !c.status || c.status === 'active');
      const { required } = parseSlotInfo(slot.label, activeCourses.length);
      const selected = (selections[slot.id] ?? []).length;
      if (selected < required) n++;
    }
    return n;
  }, 0);
  const isFormComplete = requirements.length > 0 && unsatisfiedCount === 0;

  if (submitted) {
    return (
      <div className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-2 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 rounded-lg border border-emerald-100 dark:border-emerald-900/50">
        <CheckCircle2 size={14} />
        {type === 'major' ? 'Major' : 'Minor'} course selections submitted ({filledCount} courses)
      </div>
    );
  }

  if (loading) return <div className="mt-4 w-[460px] rounded-2xl border border-zinc-200 dark:border-zinc-800 px-5 py-6 text-sm text-zinc-400">Loading {programName} requirements...</div>;
  if (fetchError) return (
    <div className="mt-4 w-[460px] rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/20 px-5 py-4 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-red-600 dark:text-red-400">Failed to load requirements</p>
        <p className="text-xs text-red-400 dark:text-red-500 mt-0.5 truncate">{fetchError}</p>
      </div>
      <button
        onClick={() => { setFetchError(null); setStableProgramName(''); setTimeout(() => setStableProgramName(programName), 50); }}
        className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-800/40 transition-colors border border-red-200 dark:border-red-700">
        Retry
      </button>
    </div>
  );

  return (
    <div className="mt-4 w-[500px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Select {type === 'major' ? 'Major' : 'Minor'} Courses</h3>
        <p className="text-xs text-zinc-500 mt-1">{programName} &middot; {filledCount} courses selected</p>
        <div className="mt-2 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div className="h-1.5 rounded-full bg-black dark:bg-white transition-all" style={{ width: `${totalSlots > 0 ? Math.min(100, (filledCount / totalSlots) * 100) : 0}%` }} />
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="max-h-[500px] overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800">
          {requirements.map(req => {
            const id = String(req.requirementId);
            const isOpen = !!expandedIds[id];
            const slots = getSlots(req);

            return (
              <div key={id}>
                <button type="button" onClick={() => setExpandedIds(p => ({ ...p, [id]: !p[id] }))}
                  className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors">
                  <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">{req.description}</span>
                  <span className="text-zinc-400 text-xs ml-2">{isOpen ? '▲' : '▼'}</span>
                </button>

                {isOpen && (
                  <div className="px-5 pb-4 space-y-4">
                    {req.otherRequirement && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 rounded-lg border border-amber-200 dark:border-amber-800">{req.otherRequirement}</p>
                    )}
                    {req.notes && <p className="text-xs text-zinc-500 italic">{typeof req.notes === 'string' ? req.notes : ''}</p>}

                    {slots.map(slot => {
                      const activeCourses = slot.courses.filter(c => !c.status || c.status === 'active');
                      const info = parseSlotInfo(slot.label, activeCourses.length);
                      const q = searchQ[slot.id] ?? '';
                      const vis = q ? activeCourses.filter(c => c.code.toLowerCase().includes(q.toLowerCase()) || c.title.toLowerCase().includes(q.toLowerCase())) : activeCourses;
                      const sel = selections[slot.id] ?? [];
                      const isAutoAll = info.required === activeCourses.length;

                      // Check if requirement is fully fulfilled by transcript
                      const transcriptMatches = activeCourses.filter(c => isCourseCompleted(c.code));
                      const isFulfilledByTranscript = transcriptMatches.length >= info.required;

                      return (
                        <div key={slot.id} className="space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{slot.label}</p>
                            {isAutoAll && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 font-medium">All required</span>
                            )}
                            {isFulfilledByTranscript && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 font-medium flex items-center gap-1">
                                <CheckCircle2 size={10} /> Requirement fulfilled
                              </span>
                            )}
                            {!isAutoAll && info.required > 1 && (
                              <span className="text-[10px] text-zinc-400">({sel.length}/{info.required} selected)</span>
                            )}
                          </div>

                          {activeCourses.length > 5 && (
                            <input type="text" placeholder="Search courses..." value={q}
                              onChange={e => setSearchQ(p => ({ ...p, [slot.id]: e.target.value }))}
                              className="w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white" />
                          )}
                          <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                            {vis.map(c => {
                              const isSelected = sel.includes(c.code);
                              const isFromTranscript = isCourseCompleted(c.code);
                              const isDisabled = isAutoAll; // Can't deselect auto-all

                              return (
                                <label key={`${slot.id}-${c.code}`}
                                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-all text-xs ${isDisabled ? 'cursor-default' : 'cursor-pointer'} ${isSelected ? 'border-black bg-zinc-50 dark:border-white dark:bg-zinc-900' : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'}`}>
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    disabled={isDisabled}
                                    onChange={() => {
                                      if (isDisabled) return;
                                      if (info.required === 1) {
                                        // Single-select: toggle off or replace
                                        setSelections(p => ({ ...p, [slot.id]: isSelected ? [] : [c.code] }));
                                      } else {
                                        toggleCourse(slot.id, c.code, info.required);
                                      }
                                    }}
                                    className="w-3.5 h-3.5 accent-black dark:accent-white shrink-0" />
                                  <span className="font-mono text-zinc-400 shrink-0">{c.code}</span>
                                  <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">{c.title}</span>
                                  <span className="ml-auto text-zinc-400 shrink-0">{c.credits} cr</span>
                                  {isFromTranscript && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-700 shrink-0 font-medium">✓ Completed</span>
                                  )}
                                </label>
                              );
                            })}
                          </div>
                          {sel.length > 0 && !isAutoAll && (
                            <button type="button" onClick={() => setSelections(p => ({ ...p, [slot.id]: [] }))}
                              className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 underline">Clear</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-t border-zinc-200 dark:border-zinc-800 px-5 py-4 space-y-2">
          <button type="submit"
            disabled={!isFormComplete}
            className={`w-full rounded-xl py-3 text-sm font-medium transition-all shadow-sm ${isFormComplete
              ? 'bg-black text-white dark:bg-white dark:text-black hover:scale-[1.02]'
              : 'bg-zinc-200 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-600 cursor-not-allowed'
              }`}>
            {isFormComplete
              ? `Submit ${filledCount} Course${filledCount !== 1 ? 's' : ''}`
              : `${unsatisfiedCount} requirement${unsatisfiedCount !== 1 ? 's' : ''} left to fill`}
          </button>

          <button
            type="button"
            onClick={() => {
              setSubmitted(true);
              addToolOutput({ tool: tool.toolName, toolCallId: tool.toolCallId, output: { action: "skipped" } });
              sendMessage({ text: `[System: User chose to skip selecting courses for ${type === 'major' ? 'Major' : 'Minor'}. Check with them on how they want to proceed or move to the next step.]` });
            }}
            className="w-full rounded-xl py-3 text-sm font-medium transition-all text-zinc-500 hover:text-black dark:text-zinc-400 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Skip / Choose Something Else
          </button>
        </div>
      </form>
    </div>
  );
}


