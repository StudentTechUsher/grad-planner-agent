"use client";

import { useChat } from "@ai-sdk/react";
import {
  User, Bot, Send, CheckCircle2, FileText, UploadCloud, FileEdit, Building2, BriefcaseIcon, Loader2, LibraryBig, ChevronDown, ChevronRight, Edit3, Upload
} from "lucide-react";
import { AgentChatInput } from "../components/AgentChatInput";
import { MajorSelectionForm } from "../components/forms/MajorSelectionForm";
import { useState, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import PlanPlayground from "./components/PlanPlayground";

const PREFERENCE_TOOL_NAMES = new Set(["requestUserPreferences", "updateUserPreferences"]);
type StudentType = "undergrad" | "honors" | "graduate";
type SessionStatus = "authenticating" | "authenticated" | "unauthenticated";

type BootstrapPayload = {
  user?: { id?: string; email?: string | null };
  error?: string;
  bootstrap?: {
    preferences?: Record<string, any>;
    transcriptCourses?: any[];
    transcriptSummary?: string;
    priorPlanMeta?: {
      plan?: any[];
      milestones?: any[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  relaunchUrl?: string;
};

type ConversationResolvePayload = {
  sessionId?: string;
  source?: "requested" | "latest" | "created";
  chatMessages?: any[];
  stateSnapshot?: Record<string, any>;
  updatedAt?: string;
  error?: string;
};

const CLIENT_RELAUNCH_URL =
  process.env.NEXT_PUBLIC_AGENT_RELAUNCH_URL || "https://app.stuplanning.com/grad-plan";

function normalizeStudentType(raw: unknown): StudentType {
  if (raw === "honors") return "honors";
  if (raw === "graduate" || raw === "grad") return "graduate";
  return "undergrad";
}

function extractToolInvocations(msg: any): any[] {
  if (Array.isArray(msg?.toolInvocations) && msg.toolInvocations.length > 0) return msg.toolInvocations;
  if (!Array.isArray(msg?.parts)) return [];
  return msg.parts
    .filter((p: any) => p.type?.startsWith("tool-") || p.type === "tool-call")
    .map((p: any) => ({
      toolName: p.toolName || p.type.replace("tool-", ""),
      state: p.state === "output-available" || p.state === "result" ? "result" : "call",
      result: p.result || p.output,
    }));
}

function getLatestPreferencesFromMessages(messages: any[]): any | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tools = extractToolInvocations(messages[i]);
    for (const tool of tools) {
      if (tool?.state === "result" && PREFERENCE_TOOL_NAMES.has(tool.toolName) && tool.result) {
        return tool.result;
      }
    }
  }
  return undefined;
}

function suggestPlanName(planData: any): string {
  const terms = Array.isArray(planData?.plan) ? planData.plan : [];
  if (terms.length === 0) {
    return "My Graduation Plan";
  }

  const nonEmptyTerms = terms.filter((term: any) => Array.isArray(term?.courses) && term.courses.length > 0);
  const firstTerm = (nonEmptyTerms[0]?.term || terms[0]?.term || "").trim();
  const lastTerm = (nonEmptyTerms[nonEmptyTerms.length - 1]?.term || terms[terms.length - 1]?.term || "").trim();

  const allCourses = terms.flatMap((term: any) => (Array.isArray(term?.courses) ? term.courses : []));
  const subjectCounts = new Map<string, number>();

  for (const course of allCourses) {
    const code = typeof course?.code === "string" ? course.code.trim().toUpperCase() : "";
    if (!code) continue;
    const subjectMatch = code.match(/^([A-Z]{2,}(?:\s+[A-Z]{1,4})*)\s*\d/);
    const subject = subjectMatch?.[1]?.trim();
    if (!subject) continue;
    subjectCounts.set(subject, (subjectCounts.get(subject) || 0) + 1);
  }

  let dominantSubject = "";
  let dominantCount = 0;
  for (const [subject, count] of subjectCounts.entries()) {
    if (count > dominantCount) {
      dominantSubject = subject;
      dominantCount = count;
    }
  }

  const withRange = firstTerm && lastTerm;
  const termRange = withRange ? ` (${firstTerm} - ${lastTerm})` : "";
  if (dominantSubject && dominantCount >= 3) {
    return `${dominantSubject} Focus Plan${termRange}`.trim();
  }

  if (withRange) {
    return `Graduation Plan (${firstTerm} - ${lastTerm})`;
  }

  return "My Graduation Plan";
}

export default function Home() {
  const [planId, setPlanId] = useState(() => crypto.randomUUID());
  const [sessionResolved, setSessionResolved] = useState(false);
  const [isConversationPersistenceEnabled, setIsConversationPersistenceEnabled] = useState(false);
  const [initialChatMessages, setInitialChatMessages] = useState<any[]>([]);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("authenticating");
  const [authError, setAuthError] = useState<string>("");
  const [relaunchUrl, setRelaunchUrl] = useState<string>(CLIENT_RELAUNCH_URL);
  const [bootstrap, setBootstrap] = useState<BootstrapPayload["bootstrap"] | null>(null);

  // @ts-ignore
  const { messages, sendMessage, status, addToolResult, addToolOutput } = useChat({
    // @ts-ignore
    api: `/api/chat?planId=${planId}`,
    id: `chat-${planId}`,
    messages: initialChatMessages,
  });
  // @ts-ignore
  const scaffoldChat = useChat({ api: '/api/scaffold', id: `scaffold-${planId}` });
  const [input, setInput] = useState("");
  const isLoading = status === "submitted" || status === "streaming";

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement> | React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    // If the user types a manual message while tool forms are pending,
    // resolve any unresolved tool call so the request stream can continue safely.
    if (messages.length > 0) {
      const pendingToolCalls = new Map<string, string>();

      for (const msg of messages as any[]) {
        if (Array.isArray(msg?.toolInvocations)) {
          for (const tool of msg.toolInvocations) {
            const toolCallId = typeof tool?.toolCallId === "string" ? tool.toolCallId : "";
            if (!toolCallId) continue;
            const hasResult =
              tool?.state === "result" ||
              tool?.state === "output-available" ||
              tool?.result !== undefined ||
              tool?.output !== undefined;
            if (hasResult) continue;
            const toolName = typeof tool?.toolName === "string" && tool.toolName.length > 0 ? tool.toolName : "unknown";
            pendingToolCalls.set(toolCallId, toolName);
          }
        }

        if (Array.isArray(msg?.parts)) {
          for (const part of msg.parts) {
            const type = typeof part?.type === "string" ? part.type : "";
            if (!type.startsWith("tool-") && type !== "tool-call") continue;
            const toolCallId = typeof part?.toolCallId === "string" ? part.toolCallId : "";
            if (!toolCallId) continue;
            const hasResult =
              part?.state === "result" ||
              part?.state === "output-available" ||
              part?.result !== undefined ||
              part?.output !== undefined;
            if (hasResult) continue;
            const toolName =
              typeof part?.toolName === "string" && part.toolName.length > 0
                ? part.toolName
                : type.replace("tool-", "") || "unknown";
            pendingToolCalls.set(toolCallId, toolName);
          }
        }
      }

      for (const [toolCallId, toolName] of pendingToolCalls.entries()) {
        try {
          // @ts-ignore
          if (addToolResult) addToolResult({ toolCallId, result: { action: "interrupted_by_user", userMessage: input } });
          else if (addToolOutput) addToolOutput({ tool: toolName, toolCallId, output: { action: "interrupted_by_user", userMessage: input } });
        } catch (_err) { }
      }
    }

    sendMessage({ text: input });
    setInput("");
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // App state
  const [progress, setProgress] = useState<{ total: number; completed: number } | null>(null);
  const [liveJson, setLiveJson] = useState<any>(null);
  const [transcriptCourses, setTranscriptCourses] = useState<any[]>([]);
  const [isPlanSound, setIsPlanSound] = useState(false);
  const [showDevToolLog, setShowDevToolLog] = useState(false);
  const isDevBuild = process.env.NODE_ENV !== "production";
  const lastSyncedPayloadRef = useRef<string>("");
  const inFlightSyncPayloadRef = useRef<string>("");

  useEffect(() => {
    let cancelled = false;

    const loadBootstrap = async () => {
      try {
        const res = await fetch("/api/session/bootstrap", { credentials: "include" });
        const payload: BootstrapPayload = await res.json();

        if (cancelled) return;

        if (!res.ok) {
          setSessionStatus("unauthenticated");
          setAuthError(typeof payload?.error === "string" ? payload.error : "Authentication session is not valid.");
          setRelaunchUrl(payload?.relaunchUrl || CLIENT_RELAUNCH_URL);
          setSessionResolved(true);
          setIsConversationPersistenceEnabled(false);
          return;
        }

        let resolvedConversation: ConversationResolvePayload | null = null;
        try {
          const requestedSessionId =
            typeof window !== "undefined"
              ? new URL(window.location.href).searchParams.get("sessionId") || undefined
              : undefined;

          const resolveRes = await fetch("/api/session/conversation/resolve", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestedSessionId }),
          });
          const resolvePayload: ConversationResolvePayload = await resolveRes.json();
          if (resolveRes.ok) {
            resolvedConversation = resolvePayload;
          }
        } catch {
          // Keep legacy behavior if conversation resolve fails.
          resolvedConversation = null;
        }

        const snapshot = resolvedConversation?.stateSnapshot ?? {};
        const snapshotLiveJson = snapshot && typeof snapshot.liveJson === "object" ? snapshot.liveJson : null;
        const snapshotPreferences = snapshot && typeof snapshot.preferences === "object" ? snapshot.preferences : null;
        const snapshotTranscriptCourses = Array.isArray(snapshot?.transcriptCourses) ? snapshot.transcriptCourses : null;
        const snapshotTranscriptSummary = typeof snapshot?.transcriptSummary === "string" ? snapshot.transcriptSummary : null;

        const mergedBootstrap: BootstrapPayload["bootstrap"] = {
          ...(payload.bootstrap ?? {}),
          preferences: {
            ...(payload.bootstrap?.preferences ?? {}),
            ...(snapshotPreferences ?? {}),
          },
          transcriptCourses: snapshotTranscriptCourses ?? payload.bootstrap?.transcriptCourses ?? [],
          transcriptSummary: snapshotTranscriptSummary ?? payload.bootstrap?.transcriptSummary ?? "",
          priorPlanMeta: {
            ...(payload.bootstrap?.priorPlanMeta ?? {}),
            plan: Array.isArray(snapshotLiveJson?.plan)
              ? snapshotLiveJson.plan
              : payload.bootstrap?.priorPlanMeta?.plan ?? [],
            milestones: Array.isArray(snapshotLiveJson?.milestones)
              ? snapshotLiveJson.milestones
              : payload.bootstrap?.priorPlanMeta?.milestones ?? [],
          },
        };

        setBootstrap(mergedBootstrap);

        const bootstrapTranscript = Array.isArray(mergedBootstrap?.transcriptCourses)
          ? mergedBootstrap.transcriptCourses
          : [];
        if (bootstrapTranscript.length > 0) {
          setTranscriptCourses(bootstrapTranscript);
        }

        if (Array.isArray(mergedBootstrap?.priorPlanMeta?.plan) && mergedBootstrap.priorPlanMeta.plan.length > 0) {
          setLiveJson({
            plan: mergedBootstrap.priorPlanMeta.plan,
            milestones: Array.isArray(mergedBootstrap.priorPlanMeta.milestones)
              ? mergedBootstrap.priorPlanMeta.milestones
              : [],
          });
        }

        if (
          resolvedConversation &&
          typeof resolvedConversation.sessionId === "string" &&
          resolvedConversation.sessionId.length > 0
        ) {
          setInitialChatMessages(Array.isArray(resolvedConversation.chatMessages) ? resolvedConversation.chatMessages : []);
          setPlanId(resolvedConversation.sessionId);

          if (typeof window !== "undefined") {
            const url = new URL(window.location.href);
            if (url.searchParams.get("sessionId") !== resolvedConversation.sessionId) {
              url.searchParams.set("sessionId", resolvedConversation.sessionId);
              window.history.replaceState({}, "", url.toString());
            }
          }
          setIsConversationPersistenceEnabled(true);
        } else {
          setIsConversationPersistenceEnabled(false);
        }

        setSessionStatus("authenticated");
        setSessionResolved(true);
      } catch (error) {
        if (cancelled) return;
        setSessionStatus("unauthenticated");
        setAuthError(error instanceof Error ? error.message : "Failed to validate authentication session.");
        setSessionResolved(true);
        setIsConversationPersistenceEnabled(false);
      }
    };

    loadBootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionResolved || sessionStatus !== "authenticated") return;
    if (!isConversationPersistenceEnabled) return;
    if (status !== "ready") return;
    if (!planId) return;
    const latestPreferences =
      getLatestPreferencesFromMessages(messages as any[]) ?? bootstrap?.preferences ?? {};

    const stateSnapshot = {
      liveJson: liveJson ?? null,
      preferences: (latestPreferences && typeof latestPreferences === "object") ? latestPreferences : {},
      transcriptCourses: Array.isArray(transcriptCourses) ? transcriptCourses : [],
      transcriptSummary: typeof bootstrap?.transcriptSummary === "string" ? bootstrap.transcriptSummary : "",
    };

    const payload = {
      chatMessages: messages,
      stateSnapshot,
    };
    const serializedPayload = JSON.stringify(payload);
    if (serializedPayload === lastSyncedPayloadRef.current) return;
    if (serializedPayload === inFlightSyncPayloadRef.current) return;

    const timeoutId = setTimeout(async () => {
      inFlightSyncPayloadRef.current = serializedPayload;
      try {
        const res = await fetch(`/api/session/conversation/${planId}`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: serializedPayload,
        });

        if (res.ok) {
          lastSyncedPayloadRef.current = serializedPayload;
          return;
        }

        if (res.status === 413) {
          console.warn("Session payload too large; skipping sync for this snapshot.");
          return;
        }
      } catch {
        console.warn("Session sync failed; will retry on next state change.");
      } finally {
        inFlightSyncPayloadRef.current = "";
      }
    }, 700);

    return () => clearTimeout(timeoutId);
  }, [sessionResolved, sessionStatus, isConversationPersistenceEnabled, status, planId, messages, liveJson, transcriptCourses, bootstrap?.preferences, bootstrap?.transcriptSummary]);

  const preferences = useMemo(
    () => getLatestPreferencesFromMessages(messages as any[]) ?? bootstrap?.preferences,
    [messages, bootstrap?.preferences]
  );
  const workflowProgress = useMemo(() => {
    const toolInvocations = (messages as any[]).flatMap((message) => extractToolInvocations(message));
    const resultInvocations = toolInvocations.filter((tool) => tool?.state === "result");
    const hasResult = (toolName: string) => resultInvocations.some((tool) => tool.toolName === toolName);
    const hasToolAnyState = (toolName: string) => toolInvocations.some((tool) => tool.toolName === toolName);
    const latestResult = (toolName: string) => {
      for (let i = resultInvocations.length - 1; i >= 0; i--) {
        const tool = resultInvocations[i];
        if (tool.toolName === toolName) return tool.result;
      }
      return undefined;
    };

    const studentType = normalizeStudentType(preferences?.studentType);
    const latestMinorSelection: any = latestResult("requestMinorSelection");
    const latestMajorCoursesResult: any = latestResult("selectMajorCourses");
    const latestMajorCourseAction =
      latestMajorCoursesResult &&
      typeof latestMajorCoursesResult === "object" &&
      typeof latestMajorCoursesResult.action === "string"
        ? latestMajorCoursesResult.action
        : null;
    const majorSelectionReset = latestMajorCourseAction === "change_major";
    const latestMinorCoursesResult: any = latestResult("selectMinorCourses");
    const latestMinorCourseAction =
      latestMinorCoursesResult &&
      typeof latestMinorCoursesResult === "object" &&
      typeof latestMinorCoursesResult.action === "string"
        ? latestMinorCoursesResult.action
        : null;
    const minorExplicitlySkipped =
      latestMinorCourseAction === "skip_minor" || latestMinorCourseAction === "change_minor";
    const minorSelected =
      !!latestMinorSelection &&
      typeof latestMinorSelection === "object" &&
      !!latestMinorSelection.selectedProgram &&
      latestMinorSelection.skipped !== true &&
      !minorExplicitlySkipped;

    const latestHeuristics: any = latestResult("checkPlanHeuristics");
    let heuristicsClean = false;
    if (latestHeuristics && typeof latestHeuristics === "object") {
      const warnings = Array.isArray(latestHeuristics.warnings) ? latestHeuristics.warnings : [];
      const totalUnplanned =
        typeof latestHeuristics.totalUnplanned === "number" ? latestHeuristics.totalUnplanned : 0;
      const inferredSound = warnings.length === 0 && totalUnplanned === 0;
      heuristicsClean =
        typeof latestHeuristics.isPlanSound === "boolean"
          ? latestHeuristics.isPlanSound
          : inferredSound;
      if (totalUnplanned > 0) heuristicsClean = false;
    }

    const applyForGraduationInserted = resultInvocations.some((tool) => {
      if (tool.toolName !== "insertMilestone" && tool.toolName !== "insertAcademicMilestone") return false;
      const result: any = tool.result;
      const singleMilestoneName =
        result?.milestone?.title || result?.milestone?.type || result?.milestoneName;
      if (
        typeof singleMilestoneName === "string" &&
        singleMilestoneName.toLowerCase() === "apply for graduation"
      ) {
        return true;
      }
      const milestoneList = Array.isArray(result?.milestones) ? result.milestones : [];
      return milestoneList.some(
        (milestone: any) =>
          typeof milestone?.title === "string" &&
          milestone.title.toLowerCase() === "apply for graduation"
      );
    });

    const steps: Array<{ id: string; done: boolean }> = [
      {
        id: "preferences",
        done: hasResult("requestUserPreferences") || hasResult("updateUserPreferences"),
      },
      {
        id: studentType === "graduate" ? "graduate-program" : "major-selection",
        done: hasResult("requestMajorSelection"),
      },
      {
        id: studentType === "graduate" ? "graduate-courses" : "major-courses",
        done: hasResult("selectMajorCourses") && !majorSelectionReset,
      },
    ];

    if (studentType !== "graduate") {
      steps.push({
        id: "minor-selection",
        done: hasResult("requestMinorSelection"),
      });
      if (minorSelected) {
        steps.push({
          id: "minor-courses",
          done: hasResult("selectMinorCourses"),
        });
      }
      if (studentType === "honors") {
        steps.push({
          id: "honors-selection",
          done: hasResult("requestHonorsSelection"),
        });
      }
      steps.push({
        id: "gen-ed-selection",
        done: hasResult("selectGenEdCourses") || hasResult("requestGenEdSelection"),
      });
    }

    steps.push(
      { id: "heuristics", done: heuristicsClean },
      { id: "milestones-form", done: hasResult("addMilestones") },
      { id: "apply-for-graduation", done: applyForGraduationInserted },
      { id: "plan-review", done: hasToolAnyState("requestPlanReview") }
    );

    let completed = 0;
    for (const step of steps) {
      if (!step.done) break;
      completed += 1;
    }

    const total = Math.max(steps.length, 1);
    const current = completed >= total ? total : Math.min(completed + 1, total);
    const started = toolInvocations.length > 0;

    return {
      started,
      completed,
      total,
      label: completed >= total ? "Plan Complete" : `Step ${current} of ${total}`,
      percent: Math.min(100, Math.round((completed / total) * 100)),
    };
  }, [messages, preferences?.studentType]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Extract progress from creditsCalculator tool and JSON scaffold from generateGradPlanScaffold
  useEffect(() => {
    for (let i = 0; i < messages.length; i++) {
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
          if (tool.toolName === "creditsCalculator" && tool.state === "result") {
            const { totalRequired, completedCredits } = tool.args;
            setProgress({ total: totalRequired, completed: completedCredits });
          }
          if (tool.toolName === "generateGradPlanScaffold" && tool.state === "result" && tool.result?.scaffold) {
            setLiveJson(tool.result.scaffold);
          }

          if (['createTerm', 'deleteTerm', 'addCoursesToTerm', 'removeCourseFromTerm'].includes(tool.toolName) && tool.state === "result" && tool.result?.plan) {
            setLiveJson((prev: any) => ({
              ...(prev ?? {}),
              plan: tool.result.plan,
              milestones: Array.isArray(tool.result?.milestones) ? tool.result.milestones : (prev?.milestones ?? []),
            }));
            setIsPlanSound(false); // Reset if they are still editing
          }

          if (['insertMilestone', 'insertAcademicMilestone'].includes(tool.toolName) && tool.state === "result") {
            setLiveJson((prev: any) => ({
              ...(prev ?? {}),
              plan: Array.isArray(tool.result?.plan) ? tool.result.plan : (prev?.plan ?? []),
              milestones: Array.isArray(tool.result?.milestones) ? tool.result.milestones : (prev?.milestones ?? []),
            }));
          }

          if (tool.toolName === "checkPlanHeuristics" && tool.state === "result") {
            if (typeof tool.result?.isPlanSound === "boolean") {
              setIsPlanSound(tool.result.isPlanSound === true);
            } else if (tool.result?.message && (!Array.isArray(tool.result?.warnings) || tool.result.warnings.length === 0)) {
              setIsPlanSound(true);
            } else {
              setIsPlanSound(false);
            }
          }
        }
      }
    }

    // Process scaffoldChat messages for plan updates and workflow steps
    for (let i = 0; i < scaffoldChat.messages.length; i++) {
      const msg = scaffoldChat.messages[i] as any;
      const tools = msg.toolInvocations || [];
      if (tools.length > 0) {
        for (const tool of tools) {
          if (tool.toolName === "updateGradPlan" && tool.state === "result") {
            // When tool is complete, use the rigorously enforced plan returned from the backend
            if (tool.result?.plan) {
              setLiveJson((prev: any) => ({
                ...(prev ?? {}),
                plan: tool.result.plan,
                milestones: Array.isArray(tool.result?.milestones) ? tool.result.milestones : (prev?.milestones ?? []),
              }));
            } else {
              setLiveJson((prev: any) => ({
                ...(prev ?? {}),
                plan: tool.args.terms,
                milestones: prev?.milestones ?? [],
              }));
            }
          } else if (tool.toolName === "updateGradPlan") {
            try {
              const args = typeof tool.args === 'string' ? JSON.parse(tool.args) : tool.args;
              if (args?.terms) {
                setLiveJson((prev: any) => ({
                  ...(prev ?? {}),
                  plan: args.terms,
                  milestones: prev?.milestones ?? [],
                })); // Partial streaming update
              }
            } catch (e) { }
          }
        }
      }
    }
  }, [messages, scaffoldChat.messages]);

  const percentage = progress ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : 0;

  // Disable input only while the agent is actively streaming/thinking
  const isInputDisabled = isLoading || sessionStatus !== "authenticated";

  const allToolLogs = useMemo(
    () =>
      [...messages, ...scaffoldChat.messages].flatMap((m: any) =>
        ((m.toolInvocations) || (m.parts?.filter((p: any) => p.type.startsWith('tool-') || p.type === 'tool-call').map((p: any) => ({
          toolCallId: p.toolCallId,
          toolName: p.toolName || p.type.replace('tool-', ''),
          state: p.state === 'output-available' || p.state === 'result' ? 'result' : 'call',
          args: p.args || p.input,
          result: p.result || p.output,
        })))) || []
      ),
    [messages, scaffoldChat.messages]
  );

  const remainingCoursesStatus = useMemo(() => {
    const combinedMessages = [...messages, ...scaffoldChat.messages];
    for (let i = combinedMessages.length - 1; i >= 0; i--) {
      const toolInvocations = extractToolInvocations(combinedMessages[i] as any);
      for (let j = toolInvocations.length - 1; j >= 0; j--) {
        const tool = toolInvocations[j];
        if (tool?.state !== "result") continue;
        const result = tool?.result as any;
        if (!result || typeof result !== "object" || !Array.isArray(result.remainingCourses)) continue;

        const normalizedCourses = result.remainingCourses
          .filter((course: any) => course && typeof course.code === "string")
          .map((course: any) => ({
            code: course.code,
            title: typeof course.title === "string" ? course.title : course.code,
            credits: typeof course.credits === "number" ? course.credits : null,
            source: typeof course.source === "string" ? course.source : "",
          }));

        return {
          totalUnplanned: typeof result.totalUnplanned === "number" ? result.totalUnplanned : normalizedCourses.length,
          remainingCourses: normalizedCourses,
          sourceTool: tool.toolName,
        };
      }
    }
    return null;
  }, [messages, scaffoldChat.messages]);

  if (sessionStatus === "authenticating") {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <div className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          <Loader2 size={16} className="animate-spin" />
          Authenticating your session...
        </div>
      </div>
    );
  }

  if (sessionStatus === "unauthenticated") {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-zinc-50 px-6 dark:bg-zinc-950">
        <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Session Required</h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            {authError || "Your session has expired. Launch the planner again from stuplanning to continue."}
          </p>
          <a
            href={relaunchUrl}
            className="mt-4 inline-flex rounded-lg bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
          >
            Return to Stuplanning
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-zinc-50 dark:bg-zinc-950 font-sans text-zinc-900 dark:text-zinc-100 selection:bg-zinc-300 dark:selection:bg-zinc-700">

      {/* LEFT COLUMN: CHAT */}
      <div className="flex w-full lg:w-2/5 flex-col lg:border-r border-zinc-200 dark:border-zinc-800 relative z-10 transition-all">
        {/* Header */}
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-6 bg-white dark:bg-black z-10">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-black text-white dark:bg-white dark:text-black shadow-sm">
              <Bot size={18} />
            </div>
            <h1 className="text-lg font-medium tracking-tight">Grad Planner AI</h1>
          </div>
          {/* Workflow Progress (If initialized) */}
          {workflowProgress.started && (
            <div className="flex items-center gap-3 text-xs font-medium">
              <span className="text-zinc-500 hidden sm:inline">
                {workflowProgress.label}
              </span>
              <div className="h-2 w-24 sm:w-32 md:w-32 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${workflowProgress.percent}%` }}
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
            {remainingCoursesStatus && (
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Courses Remaining To Place</p>
                  <span className={`text-xs font-semibold px-2 py-1 rounded-full border ${remainingCoursesStatus.totalUnplanned > 0
                    ? "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
                    : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
                    }`}>
                    {remainingCoursesStatus.totalUnplanned}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-zinc-500">
                  Updated via <code>{remainingCoursesStatus.sourceTool}</code>
                </p>

                {remainingCoursesStatus.remainingCourses.length > 0 ? (
                  <div className="mt-3 max-h-48 overflow-y-auto space-y-1.5 pr-1">
                    {remainingCoursesStatus.remainingCourses.slice(0, 12).map((course: any) => (
                      <div key={`remaining-${course.code}`} className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/50 px-2.5 py-2">
                        <span className="font-mono text-[11px] text-zinc-500 shrink-0">{course.code}</span>
                        <span className="text-xs text-zinc-800 dark:text-zinc-200 truncate">{course.title}</span>
                        {course.credits != null && (
                          <span className="ml-auto text-[11px] text-zinc-500 shrink-0">{course.credits} cr</span>
                        )}
                      </div>
                    ))}
                    {remainingCoursesStatus.remainingCourses.length > 12 && (
                      <p className="text-[11px] text-zinc-500 px-1">
                        +{remainingCoursesStatus.remainingCourses.length - 12} more course(s)
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-emerald-700 dark:text-emerald-300 mt-2">
                    All selected courses are currently placed in terms.
                  </p>
                )}
              </div>
            )}
            {messages.length === 0 ? (
              <div className="flex h-[50vh] flex-col items-center justify-center text-center space-y-5 text-zinc-400">
                <Bot size={56} className="opacity-20" />
                <div className="max-w-md space-y-2">
                  <p className="text-xl font-medium text-zinc-700 dark:text-zinc-200">Welcome to Grad Planner.</p>
                  <p className="text-sm leading-relaxed text-zinc-500 mb-6">I will guide you step-by-step through generating your graduation plan.</p>
                  <button
                    onClick={() => sendMessage({ text: "Hello, please review my preferences so we can start generating my graduation plan." })}
                    disabled={sessionStatus !== "authenticated"}
                    className="rounded-xl bg-black px-6 py-3 text-sm font-medium text-white transition-transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-white dark:text-black shadow-sm"
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
                  if (rawContent.includes('change their major selection') || rawContent.includes('change their graduate program selection')) {
                    return '↺ Program change requested';
                  }
                  if (rawContent.includes('Minor confirmed')) {
                    const match = rawContent.match(/Minor confirmed/);
                    return '✓ Minor confirmed';
                  }
                  if (rawContent.includes('selectMinorCourses')) {
                    const match = rawContent.match(/programName='([^']+)'/);
                    return match ? `✓ Minor selected: ${match[1]}` : '✓ Minor confirmed';
                  }
                  if (rawContent.includes('change their minor selection')) {
                    return '↺ Minor change requested';
                  }
                  if (rawContent.includes('not to add a minor') || rawContent.includes('selectGenEdCourses') && rawContent.includes('minor')) {
                    return '✓ No minor selected';
                  }
                  if (rawContent.includes('continue without a minor')) {
                    return '✓ No minor selected';
                  }
                  if (rawContent.includes('Major course selections submitted')) {
                    return '✓ Major courses submitted';
                  }
                  if (rawContent.includes('Minor course selections submitted')) {
                    return '✓ Minor courses submitted';
                  }
                  if (rawContent.includes('Honors acknowledgment') || rawContent.includes('requestHonorsSelection')) {
                    return '✓ Honors acknowledged';
                  }
                  if (rawContent.includes('Gen Ed course selections submitted') || rawContent.includes('getStudentTranscript')) {
                    return '✓ Gen Ed selections submitted';
                  }
                  if (rawContent.includes('Milestones submitted') || rawContent.includes('addMilestones')) {
                    return '✓ Milestones submitted';
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
                        if (tool.toolName.startsWith("request") || tool.toolName.startsWith("select") || tool.toolName === "addMilestones" || tool.toolName === "getStudentTranscript" || tool.toolName === "presentMajorOptions" || tool.toolName === "requestCareerQuestionnaire" || tool.toolName === "queryPrograms" || tool.toolName === "updateGradPlan" || tool.toolName === "updateUserPreferences") {
                          return (
                            <ToolInvocationCard
                              key={tool.toolCallId}
                              tool={tool}
                              addToolOutput={addToolOutput}
                              sendMessage={sendMessage}
                              planId={planId}
                              liveJson={liveJson}
                              transcriptCourses={transcriptCourses}
                              onTranscriptParsed={setTranscriptCourses}
                              onScaffoldUpdated={setLiveJson}
                              scaffoldChat={scaffoldChat}
                              messages={messages}
                              preferences={preferences}
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

            {isLoading && (
              <div className="flex gap-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 border border-violet-200 dark:border-violet-800/60">
                  <Loader2 size={16} className="animate-spin" />
                </div>
                <div className="flex items-center gap-2 rounded-2xl border border-violet-200 bg-violet-50 px-5 py-3 text-sm dark:border-violet-900/60 dark:bg-violet-950/20 shadow-sm text-violet-700 dark:text-violet-300">
                  <Loader2 size={16} className="animate-spin text-violet-500 dark:text-violet-400" />
                  <span>Agent is thinking in the Playground...</span>
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

      {/* RIGHT COLUMN: AGENTIC PLAYGROUND */}
      <div className="hidden lg:flex lg:w-3/5 flex-col bg-zinc-50 dark:bg-zinc-950 border-l border-zinc-200 dark:border-zinc-800 relative">
        <header className="flex h-16 shrink-0 items-center justify-between px-6 bg-white dark:bg-black z-10 border-b border-zinc-200 dark:border-zinc-800 gap-4">
          <div className="flex items-center gap-4">
            {isPlanSound && (
              <button
                onClick={() => {
                  alert("Graduation Plan Accepted! You're on track to graduate.");
                }}
                className="px-4 py-2 bg-zinc-900 hover:bg-black dark:bg-white dark:hover:bg-zinc-100 text-white dark:text-black text-xs font-bold rounded-lg shadow-sm transition-all hover:scale-[1.02] active:scale-[0.98] flex items-center gap-2 animate-in zoom-in-95 duration-300"
              >
                <CheckCircle2 size={14} />
                Accept Grad Plan
              </button>
            )}
            <div className="flex items-center gap-4">
              <h2 className="text-sm font-semibold tracking-wide uppercase text-zinc-500">Agentic Playground</h2>
              {isPlanSound && (
                <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 text-xs font-semibold animate-in fade-in slide-in-from-left-2 duration-500">
                  <CheckCircle2 size={14} />
                  <span>Plan meets graduation requirements</span>
                </div>
              )}
            </div>
          </div>
          {isDevBuild && (
            <button
              type="button"
              onClick={() => setShowDevToolLog((prev) => !prev)}
              className="px-3 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 text-xs font-semibold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors"
            >
              {showDevToolLog ? "Hide Dev Log" : "Show Dev Log"}
            </button>
          )}
        </header>
        <div className="flex-1 overflow-y-auto p-0 font-mono text-xs leading-relaxed bg-zinc-50 dark:bg-zinc-950">
          <PlanPlayground
            planData={liveJson}
            preferences={preferences}
            isBuilding={isLoading}
          />
        </div>

        {isDevBuild && (
          <AnimatePresence>
            {showDevToolLog && (
              <motion.aside
                initial={{ x: "100%", opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: "100%", opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="absolute inset-y-0 right-0 w-[420px] max-w-full bg-zinc-100 dark:bg-black/90 border-l border-zinc-200 dark:border-zinc-800 z-20 flex flex-col shadow-2xl"
              >
                <header className="flex h-12 shrink-0 items-center justify-between px-4 bg-zinc-200/60 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
                  <div className="flex items-center gap-2 text-zinc-500">
                    <Bot size={14} />
                    <h2 className="text-xs font-semibold tracking-wider uppercase">Agent Tool Execution Log</h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowDevToolLog(false)}
                    className="text-[11px] font-semibold text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-100 transition-colors"
                  >
                    Close
                  </button>
                </header>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {allToolLogs.map((tool: any) => (
                    <ToolInvocationCard
                      key={tool.toolCallId}
                      tool={tool}
                      addToolOutput={addToolOutput}
                      sendMessage={sendMessage}
                      planId={planId}
                      isLog={true}
                      liveJson={liveJson}
                      transcriptCourses={transcriptCourses}
                      onTranscriptParsed={setTranscriptCourses}
                      onScaffoldUpdated={setLiveJson}
                      scaffoldChat={scaffoldChat}
                      messages={messages}
                      preferences={preferences}
                    />
                  ))}
                  {messages.length === 0 && scaffoldChat.messages.length === 0 && (
                    <div className="flex h-full items-center justify-center text-xs text-zinc-400">
                      No backend tools executed yet.
                    </div>
                  )}
                </div>
              </motion.aside>
            )}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

function ToolInvocationCard({ tool, addToolOutput, sendMessage, planId, isLog = false, liveJson, transcriptCourses, onTranscriptParsed, onScaffoldUpdated, scaffoldChat, messages, preferences }: { tool: any, addToolOutput: (args: any) => void, sendMessage: any, planId: string, isLog?: boolean, liveJson?: any, transcriptCourses?: any[], onTranscriptParsed?: (courses: any[]) => void, onScaffoldUpdated?: (scaffold: any) => void, scaffoldChat?: any, messages?: any[], preferences?: any }) {
  const [expanded, setExpanded] = useState(false);
  const isComplete = tool.state === "result";
  const studentType = normalizeStudentType(preferences?.studentType);

  if (!isLog) {
    // Specific Generators (Generative UI interception)
    if (!isComplete && (tool.toolName === "requestUserPreferences" || tool.toolName === "updateUserPreferences")) {
      return (
        <PreferencesForm
          tool={tool}
          addToolOutput={addToolOutput}
          sendMessage={sendMessage}
          onTranscriptParsed={onTranscriptParsed}
          initialPreferences={preferences}
          initialTranscriptCourses={transcriptCourses ?? []}
        />
      );
    }
    if (isComplete && tool.toolName === "updateGradPlan") {
      return (
        <div className="mt-2 text-xs text-zinc-500 bg-zinc-50 dark:bg-zinc-800 p-2 rounded border border-zinc-200 dark:border-zinc-700">
          <div className="font-semibold text-emerald-600 dark:text-emerald-400 mb-1">Graduation Plan Updated</div>
          <div>Added <span className="font-medium text-zinc-700 dark:text-zinc-300">{tool.result?.coursesAdded ?? 'several'}</span> courses to the schedule.</div>
        </div>
      );
    }
    if (!isComplete && tool.toolName === "updateGradPlan") {
      return (
        <div className="flex items-center gap-2 mt-2 text-xs text-zinc-500 bg-zinc-50 dark:bg-zinc-800 p-2 rounded border border-zinc-200 dark:border-zinc-700">
          <Loader2 className="animate-spin text-zinc-400" size={14} />
          <span>Sub-agent is building and updating your graduation plan...</span>
        </div>
      );
    }

    if (!isComplete && tool.toolName === "requestMajorSelection") {
      return <MajorSelectionForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} studentType={studentType} />;
    }
    if (!isComplete && tool.toolName === "requestCareerQuestionnaire") {
      return <CareerQuestionnaireForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} />;
    }
    if (tool.toolName === "presentMajorOptions" && tool.state !== "result") {
      return <MajorOptionsForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} />;
    }
    if (!isComplete && tool.toolName === "requestMinorSelection") {
      return <MinorSelectionForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} studentType={studentType} />;
    }
    if (!isComplete && tool.toolName === "requestHonorsSelection") {
      return <HonorsSelectionForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} />;
    }
    if (!isComplete && tool.toolName === "requestGenEdSelection") {
      return <GenEdSelectionForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} planId={planId} transcriptCourses={transcriptCourses ?? []} onScaffoldUpdated={onScaffoldUpdated} scaffoldChat={scaffoldChat} messages={messages || []} />;
    }
    if (!isComplete && tool.toolName === "selectMajorCourses") {
      return <ProgramCourseSelectionForm
        tool={tool}
        addToolOutput={addToolOutput}
        sendMessage={sendMessage}
        planId={planId}
        type={tool.args?.programType === "graduate_no_gen_ed" ? "graduate_no_gen_ed" : "major"}
        studentType={studentType}
        transcriptCourses={transcriptCourses ?? []}
        onScaffoldUpdated={onScaffoldUpdated}
        scaffoldChat={scaffoldChat}
        messages={messages || []}
      />;
    }
    if (!isComplete && tool.toolName === "selectMinorCourses") {
      return <ProgramCourseSelectionForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} planId={planId} type="minor" studentType={studentType} transcriptCourses={transcriptCourses ?? []} onScaffoldUpdated={onScaffoldUpdated} scaffoldChat={scaffoldChat} messages={messages || []} />;
    }
    if (!isComplete && tool.toolName === "selectGenEdCourses") {
      return <GenEdSelectionForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} planId={planId} messages={messages || []} transcriptCourses={transcriptCourses ?? []} onScaffoldUpdated={onScaffoldUpdated} scaffoldChat={scaffoldChat} />;
    }
    if (!isComplete && tool.toolName === "getStudentTranscript") {
      return <TranscriptUploadForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} />;
    }
    if (!isComplete && tool.toolName === "requestPlanReview") {
      return <PlanReviewForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} liveJson={liveJson} planId={planId} />;
    }
    if (!isComplete && tool.toolName === "addMilestones") {
      return <MilestonesForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} liveJson={liveJson} />;
    }

    // queryPrograms result: automatically show options form when recommendedPrograms are available
    if (tool.toolName === "queryPrograms" && isComplete && tool.result?.recommendedPrograms?.length > 0) {
      return <QueryProgramsOptionsForm tool={tool} addToolOutput={addToolOutput} sendMessage={sendMessage} />;
    }
    // Still loading / no recommended programs yet — show nothing inline
    if (tool.toolName === "queryPrograms") return null;

    if (isComplete && (tool.toolName === "requestUserPreferences" || tool.toolName === "updateUserPreferences")) {
      return (
        <div className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400 flex items-center justify-between gap-3 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 rounded-lg border border-emerald-100 dark:border-emerald-900/50">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} />
            Preferences Submitted Successfully
          </div>
          <button
            type="button"
            onClick={() => sendMessage({ text: "[System: User requested to update preferences. Immediately call updateUserPreferences and wait for form submission.]" })}
            className="text-[11px] font-semibold px-2 py-1 rounded border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors"
          >
            Update Preferences
          </button>
        </div>
      );
    }

    // Already submitted state for these forms
    if (isComplete && (tool.toolName.startsWith("request") || tool.toolName.startsWith("select") || tool.toolName === "addMilestones" || tool.toolName === "getStudentTranscript" || tool.toolName === "presentMajorOptions")) {
      return (
        <div className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-2 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 rounded-lg border border-emerald-100 dark:border-emerald-900/50">
          <CheckCircle2 size={14} />
          Form Submitted Successfully
        </div>
      );
    }
  }

  return (
    <div className="w-full mt-2 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:bg-zinc-900/50 dark:border-zinc-800 shadow-sm text-sm">
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

function PreferencesForm({
  tool,
  addToolOutput,
  sendMessage,
  onTranscriptParsed,
  initialPreferences,
  initialTranscriptCourses,
}: {
  tool: any,
  addToolOutput: any,
  sendMessage: any,
  onTranscriptParsed?: (courses: any[]) => void,
  initialPreferences?: Record<string, any>,
  initialTranscriptCourses?: any[],
}) {
  const bootTranscriptCourses = Array.isArray(initialTranscriptCourses) ? initialTranscriptCourses : [];
  const [maxCredits, setMaxCredits] = useState(Number(initialPreferences?.maxCreditsPerTerm ?? 15));
  const [minCredits, setMinCredits] = useState(Number(initialPreferences?.minCreditsPerTerm ?? 12));
  const [genEdStrategy, setGenEdStrategy] = useState<"prioritize" | "balance">(initialPreferences?.genEdStrategy === "prioritize" ? "prioritize" : "balance");
  const [studentType, setStudentType] = useState<StudentType>(normalizeStudentType(initialPreferences?.studentType));
  const [graduationPace, setGraduationPace] = useState<"fast" | "sustainable" | "undecided">(
    initialPreferences?.graduationPace === "fast" || initialPreferences?.graduationPace === "undecided"
      ? initialPreferences.graduationPace
      : "sustainable"
  );
  const [anticipatedGraduation, setAnticipatedGraduation] = useState(String(initialPreferences?.anticipatedGraduation ?? ""));


  // Transcript upload state
  const [showTranscript, setShowTranscript] = useState(bootTranscriptCourses.length > 0);
  const [uploadMode, setUploadMode] = useState<'pdf' | 'text'>('pdf');
  const [transcriptStatus, setTranscriptStatus] = useState<'idle' | 'parsing' | 'done' | 'error'>(bootTranscriptCourses.length > 0 ? 'done' : 'idle');
  const [transcriptCourses, setTranscriptCourses] = useState<any[]>(bootTranscriptCourses);
  const [storedTranscriptCourses, setStoredTranscriptCourses] = useState<any[]>(bootTranscriptCourses);
  const [hasStoredTranscript, setHasStoredTranscript] = useState(bootTranscriptCourses.length > 0);
  const [transcriptDecision, setTranscriptDecision] = useState<'unset' | 'keep' | 'update'>(
    bootTranscriptCourses.length > 0 ? 'unset' : 'keep'
  );
  const [transcriptContextLoading, setTranscriptContextLoading] = useState(false);
  const [transcriptGpa, setTranscriptGpa] = useState<number | null>(
    typeof initialPreferences?.transcriptGpa === "number" ? initialPreferences.transcriptGpa : null
  );
  const [transcriptSummary, setTranscriptSummary] = useState(
    bootTranscriptCourses.length > 0 ? `Loaded ${bootTranscriptCourses.length} transcript courses from your account.` : ''
  );
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

  useEffect(() => {
    let cancelled = false;

    const loadStoredTranscript = async () => {
      setTranscriptContextLoading(true);
      try {
        const res = await fetch('/api/session/transcript-context', { credentials: 'include' });
        if (!res.ok) return;

        const data = await res.json();
        if (cancelled) return;

        const existingCourses = Array.isArray(data?.transcriptCourses) ? data.transcriptCourses : [];
        if (existingCourses.length > 0) {
          setHasStoredTranscript(true);
          setStoredTranscriptCourses(existingCourses);
          setTranscriptDecision('unset');
          setShowTranscript(true);
          setTranscriptCourses(existingCourses);
          setTranscriptStatus('done');
          setTranscriptSummary(
            typeof data?.transcriptSummary === 'string' && data.transcriptSummary.length > 0
              ? data.transcriptSummary
              : `Loaded ${existingCourses.length} transcript courses from your existing profile.`
          );
          return;
        }

        if (bootTranscriptCourses.length === 0) {
          setHasStoredTranscript(false);
          setTranscriptDecision('keep');
        }
      } catch {
        // Non-blocking: user can still upload manually.
      } finally {
        if (!cancelled) setTranscriptContextLoading(false);
      }
    };

    loadStoredTranscript();
    return () => {
      cancelled = true;
    };
  }, [bootTranscriptCourses.length]);

  const useExistingTranscript = () => {
    const existing = storedTranscriptCourses;
    setTranscriptDecision('keep');
    setTranscriptError('');
    if (existing.length > 0) {
      setTranscriptCourses(existing);
      setTranscriptStatus('done');
      setTranscriptSummary(`Using ${existing.length} transcript courses from your existing profile.`);
    }
  };

  const chooseTranscriptUpdate = () => {
    setTranscriptDecision('update');
    setShowTranscript(true);
    setTranscriptError('');
    setTranscriptStatus('idle');
    setTranscriptCourses([]);
    setTranscriptSummary('');
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type && file.type !== 'application/pdf') { setTranscriptError('Only PDF files are supported.'); return; }
    if (file.size > 10 * 1024 * 1024) { setTranscriptError('File must be less than 10MB.'); return; }
    void uploadTranscript(file);
    e.target.value = '';
  };

  const uploadTranscript = async (file: File) => {
    setTranscriptDecision('update');
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
    setTranscriptDecision('update');
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
    if (hasStoredTranscript && transcriptDecision === 'unset') {
      setTranscriptError('Please choose whether to keep your existing transcript or upload an update.');
      return;
    }

    const effectiveTranscriptCourses =
      transcriptDecision === 'keep' && transcriptCourses.length === 0
        ? storedTranscriptCourses
        : transcriptCourses;

    const output: any = { maxCredits, minCredits, genEdStrategy, studentType, graduationPace, anticipatedGraduation };
    if (effectiveTranscriptCourses.length > 0) {
      output.transcriptCourses = effectiveTranscriptCourses;
      output.transcriptGpa = transcriptGpa;
    }
    output.transcriptDecision = transcriptDecision;
    // Lift transcript courses to parent state (no sessionStorage needed)
    onTranscriptParsed?.(effectiveTranscriptCourses);
    addToolOutput({ tool: tool.toolName, toolCallId: tool.toolCallId, output });
    if (tool.toolName === "updateUserPreferences") {
      sendMessage({
        text: "[System: Preferences updated" + (effectiveTranscriptCourses.length > 0 ? ` with ${effectiveTranscriptCourses.length} transcript courses` : '') + ". Re-evaluate the current plan with the new constraints: call getRemainingCoursesToPlan and checkPlanHeuristics, then adjust terms/courses as needed.]"
      });
      return;
    }
    sendMessage({ text: "[System: Preferences saved" + (effectiveTranscriptCourses.length > 0 ? ` with ${effectiveTranscriptCourses.length} transcript courses` : '') + ". Now call requestMajorSelection.]" });
  };

  return (
    <div className="mt-4 w-[400px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Plan Preferences</h3>
        <p className="text-xs text-zinc-500 mt-1">Set credit limits and optionally upload your transcript.</p>
      </div>
      <form onSubmit={handleSubmit} className="p-5 space-y-5">
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Min Credits I want to take per semester</label>
          <input type="number" value={minCredits} onChange={(e) => setMinCredits(parseInt(e.target.value) || 0)}
            className="w-full rounded-xl border border-zinc-300 px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white transition-all shadow-sm" />
        </div>
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Max Credits I want to take per semester</label>
          <input type="number" value={maxCredits} onChange={(e) => setMaxCredits(parseInt(e.target.value) || 0)}
            className="w-full rounded-xl border border-zinc-300 px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white transition-all shadow-sm" />
        </div>
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Gen Ed Strategy</label>
          <div className="flex bg-zinc-100 dark:bg-zinc-900 rounded-xl p-1">
            <button type="button" onClick={() => setGenEdStrategy("prioritize")}
              className={`flex-1 py-2 px-3 text-sm font-medium rounded-lg transition-all ${genEdStrategy === "prioritize" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}>
              Prioritize Gen Eds
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
          <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Anticipated Graduation Date</label>
          <input type="text" value={anticipatedGraduation} onChange={(e) => setAnticipatedGraduation(e.target.value)} placeholder="e.g. Spring 2028 (Optional)"
            className="w-full rounded-xl border border-zinc-300 px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white transition-all shadow-sm" />
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
            <button type="button" onClick={() => setStudentType("graduate")}
              className={`flex-1 py-2 px-2 text-xs font-medium rounded-lg transition-all ${studentType === "graduate" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}>
              Grad
            </button>
          </div>
        </div>
        <div className="space-y-2 border-t border-zinc-200 dark:border-zinc-800 pt-4">
          <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Graduation Pace</label>
          <div className="flex bg-zinc-100 dark:bg-zinc-900 rounded-xl p-1 gap-1">
            <button type="button" onClick={() => setGraduationPace("fast")}
              className={`flex-1 py-2 px-2 text-xs font-medium rounded-lg transition-all ${graduationPace === "fast" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}>
              ASAP
            </button>
            <button type="button" onClick={() => setGraduationPace("sustainable")}
              className={`flex-1 py-2 px-2 text-xs font-medium rounded-lg transition-all ${graduationPace === "sustainable" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}>
              Sustainable
            </button>
            <button type="button" onClick={() => setGraduationPace("undecided")}
              className={`flex-1 py-2 px-2 text-xs font-medium rounded-lg transition-all ${graduationPace === "undecided" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}>
              Undecided
            </button>
          </div>
          <p className="text-[10px] text-zinc-500 leading-tight">
            {graduationPace === "fast" ? "Graduate as soon as possible." : graduationPace === "sustainable" ? "Maintain a comfortable workload." : "Not sure what program to commit to yet."}
          </p>
        </div>

        {/* ── Transcript Upload Section ── */}
        <div className="border-t border-zinc-200 dark:border-zinc-800 pt-4">
          <button type="button" onClick={() => setShowTranscript(!showTranscript)}
            className="flex items-center justify-between w-full text-left">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              {hasStoredTranscript ? "Transcript On File" : "Upload Transcript"} <span className="normal-case font-normal">(optional)</span>
            </span>
            <span className="text-xs text-zinc-400">{showTranscript ? '▲' : '▼'}</span>
          </button>

          {hasStoredTranscript && (
            <div className="mt-3 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-3 space-y-2">
              <p className="text-xs text-emerald-700 dark:text-emerald-300">
                We found existing transcript data in your profile. Do you want to use it as-is or upload an update?
              </p>
              {transcriptContextLoading ? (
                <div className="flex items-center gap-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                  <Loader2 size={12} className="animate-spin" />
                  Checking your saved transcript...
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={useExistingTranscript}
                    className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${transcriptDecision === 'keep'
                      ? 'border-emerald-500 bg-emerald-100 text-emerald-800 dark:border-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-200'
                      : 'border-emerald-300 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-900/40'
                      }`}
                  >
                    No Updates Needed
                  </button>
                  <button
                    type="button"
                    onClick={chooseTranscriptUpdate}
                    className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${transcriptDecision === 'update'
                      ? 'border-zinc-500 bg-zinc-200 text-zinc-800 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100'
                      : 'border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
                      }`}
                  >
                    Update Transcript
                  </button>
                </div>
              )}
              {transcriptDecision === 'keep' && transcriptSummary && (
                <p className="text-[11px] text-emerald-700 dark:text-emerald-300">{transcriptSummary}</p>
              )}
            </div>
          )}

          {showTranscript && (!hasStoredTranscript || transcriptDecision === 'update') && (
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

        <button
          type="submit"
          disabled={transcriptStatus === 'parsing' || transcriptContextLoading || (hasStoredTranscript && transcriptDecision === 'unset')}
          className="w-full rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] dark:bg-white dark:text-black mt-2 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">
          {transcriptStatus === 'parsing'
            ? 'Parsing transcript...'
            : transcriptContextLoading
              ? 'Loading transcript context...'
              : hasStoredTranscript && transcriptDecision === 'unset'
                ? 'Choose transcript option to continue'
                : 'Save Preferences'}
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

function PlanReviewForm({ tool, addToolOutput, sendMessage, liveJson, planId }: { tool: any, addToolOutput: any, sendMessage: any, liveJson: any, planId: string }) {
  const [feedback, setFeedback] = useState("");
  const [isIterating, setIsIterating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const suggestedPlanName = useMemo(() => suggestPlanName(liveJson), [liveJson]);
  const [planName, setPlanName] = useState(suggestedPlanName);
  const [hasEditedPlanName, setHasEditedPlanName] = useState(false);

  useEffect(() => {
    if (!hasEditedPlanName) {
      setPlanName(suggestedPlanName);
    }
  }, [suggestedPlanName, hasEditedPlanName]);

  const handleSaveAndReturn = async () => {
    const trimmedPlanName = planName.trim();
    if (!liveJson || isSaving || !trimmedPlanName) return;

    setIsSaving(true);
    setSaveError("");
    try {
      const res = await fetch("/api/plan/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, planName: trimmedPlanName }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Failed to save plan.");
      }

      addToolOutput({
        tool: tool.toolName,
        toolCallId: tool.toolCallId,
        output: {
          action: "saved",
          planName: trimmedPlanName,
          message: "User saved the plan and returned to Stuplanning."
        }
      });
      sendMessage({ text: "[System: The user saved the plan and returned to Stuplanning. You can conclude the conversation.]" });

      if (typeof data?.redirectTo === "string" && data.redirectTo.length > 0) {
        window.location.href = data.redirectTo;
        return;
      }
      setIsSaving(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save plan.");
      setIsSaving(false);
    }
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
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Plan Name</label>
              <input
                type="text"
                value={planName}
                maxLength={120}
                onChange={(e) => {
                  setPlanName(e.target.value);
                  setHasEditedPlanName(true);
                }}
                placeholder="Enter a plan name"
                className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white transition-all shadow-sm"
              />
              <div className="flex items-center justify-between text-[11px] text-zinc-500">
                <span>Suggested: {suggestedPlanName}</span>
                <button
                  type="button"
                  onClick={() => {
                    setPlanName(suggestedPlanName);
                    setHasEditedPlanName(false);
                  }}
                  className="font-medium text-zinc-700 underline-offset-2 hover:underline dark:text-zinc-300"
                >
                  Use Suggestion
                </button>
              </div>
            </div>
            <button
              onClick={handleSaveAndReturn}
              disabled={isSaving || !planName.trim()}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed dark:bg-white dark:text-black shadow-sm"
            >
              {isSaving ? "Saving..." : "Save & View Planning Dashboard"}
            </button>
            <button
              onClick={() => setIsIterating(true)}
              className="w-full rounded-xl bg-zinc-100 py-3 text-sm font-medium text-zinc-900 transition-transform hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
            >
              Continue Iterating
            </button>
            {saveError && (
              <p className="text-xs text-red-600 dark:text-red-400">{saveError}</p>
            )}
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

function MilestonesForm({ tool, addToolOutput, sendMessage, liveJson }: { tool: any, addToolOutput: any, sendMessage: any, liveJson: any }) {
  const optionalMilestones = ["Study Abroad", "Internship", "Research", "Apply for Graduate Program"];
  const termOptions: string[] = Array.isArray(liveJson?.plan)
    ? liveJson.plan.map((term: any) => term.term).filter((term: any) => typeof term === "string" && term.length > 0)
    : [];
  const applyForGraduationTerm = termOptions.length > 1
    ? termOptions[termOptions.length - 2]
    : termOptions[0] ?? "";

  const [selectedMilestones, setSelectedMilestones] = useState<Record<string, boolean>>({});
  const [afterTermSelections, setAfterTermSelections] = useState<Record<string, string>>({});

  const toggleMilestone = (name: string) => {
    setSelectedMilestones((prev) => {
      const nextValue = !prev[name];
      if (nextValue && !afterTermSelections[name] && termOptions.length > 0) {
        setAfterTermSelections((old) => ({ ...old, [name]: termOptions[0] }));
      }
      return { ...prev, [name]: nextValue };
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!applyForGraduationTerm) return;

    const milestones = [
      { milestoneName: "Apply For Graduation", targetTerm: applyForGraduationTerm, required: true },
      ...optionalMilestones
        .filter((name) => selectedMilestones[name])
        .map((name) => ({
          milestoneName: name,
          targetTerm: afterTermSelections[name] || termOptions[0],
          required: false,
        })),
    ];

    addToolOutput({
      tool: tool.toolName,
      toolCallId: tool.toolCallId,
      output: {
        milestones,
      },
    });

    sendMessage({
      text: "[System: Milestones submitted. Call insertMilestone for each milestone returned by addMilestones (including Apply For Graduation). Apply For Graduation must be before the final semester. After all milestone insertions are complete, call requestPlanReview.]",
    });
  };

  return (
    <div className="mt-4 w-[420px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Add Milestones</h3>
        <p className="text-xs text-zinc-500 mt-1">Milestones appear between terms in your plan.</p>
      </div>

      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        {termOptions.length === 0 ? (
          <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 rounded-xl px-3 py-2">
            No terms found yet. Build the plan terms first, then add milestones.
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 px-3 py-3 bg-zinc-50 dark:bg-zinc-900/40">
              <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">Apply For Graduation</p>
              <p className="text-xs text-zinc-500 mt-1">Required. Automatically placed after <span className="font-medium">{applyForGraduationTerm}</span>.</p>
            </div>

            <div className="space-y-3">
              {optionalMilestones.map((name) => (
                <div key={name} className="rounded-xl border border-zinc-200 dark:border-zinc-800 px-3 py-3 space-y-2">
                  <label className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                    <input
                      type="checkbox"
                      checked={!!selectedMilestones[name]}
                      onChange={() => toggleMilestone(name)}
                      className="w-4 h-4 accent-black dark:accent-white"
                    />
                    {name}
                  </label>
                  {selectedMilestones[name] && (
                    <select
                      value={afterTermSelections[name] || termOptions[0]}
                      onChange={(e) => setAfterTermSelections((prev) => ({ ...prev, [name]: e.target.value }))}
                      className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white"
                    >
                      {termOptions.map((term) => (
                        <option key={`${name}-${term}`} value={term}>
                          After {term}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <button
          type="submit"
          disabled={!applyForGraduationTerm}
          className="w-full rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed dark:bg-white dark:text-black shadow-sm"
        >
          Save Milestones
        </button>
      </form>
    </div>
  );
}


// ─── MinorSelectionForm ────────────────────────────────────────────────
// Mirrors MajorSelectionForm but for minors. Offers autocomplete search
// from the DB plus a "Skip / No Minor" escape hatch.
function MinorSelectionForm({ tool, addToolOutput, sendMessage, studentType }: { tool: any, addToolOutput: any, sendMessage: any, studentType: StudentType }) {
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
    sendMessage({
      text: studentType === "honors"
        ? "[System: User chose not to add a minor. This student is honors-track, so now immediately call requestHonorsSelection — do not ask the user, just invoke the tool.]"
        : "[System: User chose not to add a minor. Now immediately call selectGenEdCourses \u2014 do not ask the user, just invoke the tool.]"
    });
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

function HonorsSelectionForm({ tool, addToolOutput, sendMessage }: { tool: any, addToolOutput: any, sendMessage: any }) {
  const [submitted, setSubmitted] = useState(false);

  const handleAcknowledge = () => {
    setSubmitted(true);
    addToolOutput({
      tool: tool.toolName,
      toolCallId: tool.toolCallId,
      output: {
        acknowledged: true,
        message: "Honors isn't configured for your university yet",
      },
    });
    sendMessage({
      text: "[System: Honors acknowledgment captured. Now immediately call selectGenEdCourses \u2014 do not ask the user, just invoke the tool.]",
    });
  };

  if (submitted) {
    return (
      <div className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-2 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 rounded-lg border border-emerald-100 dark:border-emerald-900/50">
        <CheckCircle2 size={14} />
        Honors acknowledgment submitted
      </div>
    );
  }

  return (
    <div className="mt-4 w-[380px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Honors Courses</h3>
      </div>
      <div className="p-5 space-y-4">
        <p className="text-sm text-zinc-700 dark:text-zinc-300">Honors isn&apos;t configured for your university yet</p>
        <button
          type="button"
          onClick={handleAcknowledge}
          className="w-full rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] dark:bg-white dark:text-black shadow-sm"
        >
          Acknowledged
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
type CareerQuestion =
  | { id: string; label: string; type: "text"; placeholder: string }
  | { id: string; label: string; type: "multipleChoice"; options: string[]; otherLabel?: string };

const CAREER_QUESTIONS: CareerQuestion[] = [
  { id: "q1", label: "What is something you are naturally good at?", type: "text", placeholder: "e.g. problem-solving, communicating with people, writing..." },
  {
    id: "q2",
    label: "Do you prefer deep technical work or social-facing roles?",
    type: "multipleChoice",
    options: [
      "Deep technical work (building systems, coding, analysis)",
      "Social-facing work (clients, teams, communication)",
      "A balanced mix of both",
    ],
    otherLabel: "Other (type your own)",
  },
  { id: "q3", label: "How much do you value flexibility and remote work?", type: "text", placeholder: "e.g. Very important — I want to work anywhere, or I prefer an office..." },
  { id: "q4", label: "Do you prefer solving new, complex problems or following a structured routine?", type: "text", placeholder: "e.g. I love tackling open-ended challenges..." },
  {
    id: "q5",
    label: "Is high earning potential your primary motivator, or is work-life balance more important?",
    type: "multipleChoice",
    options: [
      "High earning potential is my top priority",
      "Work-life balance and wellbeing are more important",
      "I want a strong balance of both",
    ],
    otherLabel: "Other (type your own)",
  },
  { id: "q6", label: "Describe the type of impact you'd like your career to have:", type: "text", placeholder: "e.g. Build products used by millions, help individuals in my community..." },
];

const CAREER_OTHER_VALUE = "__other__";

function CareerQuestionnaireForm({ tool, addToolOutput, sendMessage }: { tool: any, addToolOutput: any, sendMessage: any }) {
  const [answers, setAnswers] = useState<Record<string, string>>(
    Object.fromEntries(CAREER_QUESTIONS.map(q => [q.id, ""]))
  );
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>(
    Object.fromEntries(CAREER_QUESTIONS.filter((q) => q.type === "multipleChoice").map((q) => [q.id, ""]))
  );

  const getAnswerForQuestion = (question: CareerQuestion): string => {
    if (question.type === "multipleChoice") {
      const selected = selectedOptions[question.id];
      if (selected === CAREER_OTHER_VALUE) {
        return answers[question.id].trim();
      }
      return (selected || "").trim();
    }
    return answers[question.id].trim();
  };

  const allAnswered = CAREER_QUESTIONS.every((q) => getAnswerForQuestion(q).length > 0);
  const unansweredCount = CAREER_QUESTIONS.filter((q) => getAnswerForQuestion(q).length === 0).length;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!allAnswered) return;

    // Build a structured summary for the AI / queryPrograms tool
    const normalizedAnswers = CAREER_QUESTIONS.map((q) => ({
      question: q.label,
      answer: getAnswerForQuestion(q),
    }));
    const userContext = normalizedAnswers.map((entry) => `${entry.question}\n${entry.answer}`).join("\n\n");

    addToolOutput({
      tool: tool.toolName,
      toolCallId: tool.toolCallId,
      output: {
        answers: normalizedAnswers,
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
            {q.type === "multipleChoice" ? (
              <div className="space-y-2">
                {[...q.options, q.otherLabel ?? "Other (type your own)"].map((option, index, allOptions) => {
                  const isOtherOption = index === allOptions.length - 1;
                  const optionValue = isOtherOption ? CAREER_OTHER_VALUE : option;
                  const isSelected = selectedOptions[q.id] === optionValue;
                  return (
                    <label
                      key={`${q.id}-${optionValue}`}
                      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs cursor-pointer transition-colors ${isSelected
                        ? "border-black bg-zinc-50 dark:border-white dark:bg-zinc-900"
                        : "border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600"
                        }`}
                    >
                      <input
                        type="radio"
                        name={`career-${q.id}`}
                        checked={isSelected}
                        onChange={() =>
                          setSelectedOptions((prev) => ({ ...prev, [q.id]: optionValue }))
                        }
                        className="mt-0.5 w-3.5 h-3.5 accent-black dark:accent-white shrink-0"
                      />
                      <span className="text-zinc-700 dark:text-zinc-300">{option}</span>
                    </label>
                  );
                })}
                {selectedOptions[q.id] === CAREER_OTHER_VALUE && (
                  <textarea
                    rows={2}
                    value={answers[q.id]}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    placeholder="Share your custom answer..."
                    className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3.5 py-2.5 text-sm outline-none focus:ring-2 focus:ring-black dark:focus:ring-white transition-all shadow-sm resize-none leading-relaxed placeholder:text-zinc-400"
                  />
                )}
              </div>
            ) : (
              <textarea
                rows={2}
                value={answers[q.id]}
                onChange={(e) => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                placeholder={q.placeholder}
                className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3.5 py-2.5 text-sm outline-none focus:ring-2 focus:ring-black dark:focus:ring-white transition-all shadow-sm resize-none leading-relaxed placeholder:text-zinc-400"
              />
            )}
          </div>
        ))}
        <button
          type="submit"
          disabled={!allAnswered}
          className="w-full rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed dark:bg-white dark:text-black shadow-sm"
        >
          {allAnswered ? "Find My Major" : `Answer all ${unansweredCount} remaining questions`}
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

function GenEdSelectionForm({ tool, addToolOutput, sendMessage, planId, messages, transcriptCourses, onScaffoldUpdated, scaffoldChat }: { tool: any; addToolOutput: any; sendMessage: any; planId: string; messages: any[]; transcriptCourses: any[]; onScaffoldUpdated?: (scaffold: any) => void; scaffoldChat?: any }) {
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

      const autoExpanded: Record<string, boolean> = {};
      for (let i = 0; i < reqs.length; i++) {
        const id = `${reqs[i].requirementId}-${i}`;
        const selCount = autoSelections[id]?.length || 0;
        if (selCount === 0) {
          autoExpanded[id] = true;
        }
      }
      if (Object.keys(autoExpanded).length === 0 && reqs.length > 0) {
        autoExpanded[`${reqs[0].requirementId}-0`] = true;
      }
      setExpanded(autoExpanded);
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

  const handleAutofill = () => {
    const newSelections = { ...selections };
    requirements.forEach((req, index) => {
      const id = `${req.requirementId}-${index}`;
      const needed = parseRequiredCount(req.description_rule);
      const current = (newSelections[id] || []).length;
      if (current < needed) {
        const toAdd = needed - current;
        const available = flattenActiveCourses(req).filter(c => c.code && !(newSelections[id] || []).includes(c.code));
        newSelections[id] = [
          ...(newSelections[id] || []),
          ...available.slice(0, toAdd).map(c => c.code!)
        ];
      }
    });
    setSelections(newSelections);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (submitted) return;
    setSubmitted(true);

    // Build gen ed courses for scaffold
    const genEdCourses: any[] = [];
    const filteredSelections: Record<string, string[]> = {};
    for (let i = 0; i < requirements.length; i++) {
      const req = requirements[i];
      const selectionKey = `${req.requirementId}-${i}`;
      const codes = selections[selectionKey] || [];
      const filteredCodes: string[] = [];
      for (const code of codes) {
        const allCourses = flattenActiveCourses(req);
        const course = allCourses.find(c => c.code === code);
        if (course && course.code && !isCourseCompleted(course.code)) {
          filteredCodes.push(code);
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
      filteredSelections[selectionKey] = filteredCodes;
    }

    // Fire async scaffold using useChat stream
    const preferences: any = getLatestPreferencesFromMessages(messages || []);

    if (scaffoldChat) {
      scaffoldChat.sendMessage(
        { text: 'Please distribute Gen Ed courses into my plan' },
        { body: { planId, phase: 'genEd', courses: genEdCourses, preferences } }
      );
    } else {
      fetch('/api/scaffold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId, phase: 'genEd', courses: genEdCourses }) }).then(res => res.json()).then(data => {
        if (data.scaffold && onScaffoldUpdated) {
          onScaffoldUpdated(data.scaffold);
        }
      }).catch(console.error);
    }

    addToolOutput({ tool: tool.toolName, toolCallId: tool.toolCallId, output: { catalogYear: year, genEdSelections: filteredSelections } });
    sendMessage({ text: '[System: Gen Ed course selections submitted. Do not call requestUserPreferences. Now build the graduation plan in the Playground: use `getRemainingCoursesToPlan`, `createTerm`, `addCoursesToTerm`, and `removeCourseFromTerm` to place all remaining courses. Run `checkPlanHeuristics`; if there are warnings or unplanned courses, fix them and re-run. Repeat until clean, then call `addMilestones`. After milestones are inserted, call `requestPlanReview`.]' });
  };

  const filledCount = Object.values(selections).flat().length;
  const plannableCount = requirements.reduce((total, req, index) => {
    const codes = selections[`${req.requirementId}-${index}`] || [];
    const allCourses = flattenActiveCourses(req);
    let count = 0;
    for (const code of codes) {
      const course = allCourses.find(c => c.code === code);
      if (course && course.code && !isCourseCompleted(course.code)) {
        count += 1;
      }
    }
    return total + count;
  }, 0);

  if (submitted) {
    return (
      <div className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-2 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 rounded-lg border border-emerald-100 dark:border-emerald-900/50">
        <CheckCircle2 size={14} />
        Gen Ed selections submitted ({plannableCount} course{plannableCount !== 1 ? 's' : ''} planned, {year} catalog)
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
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Plan Your GE Courses</h3>
          {process.env.NEXT_PUBLIC_SHOW_DEBUG_TOOLS === 'true' && (
            <button type="button" onClick={handleAutofill} className="text-[10px] font-medium bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/50 dark:hover:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800 px-2.5 py-1 rounded shadow-sm transition-colors">
              Auto-fill (Dev)
            </button>
          )}
        </div>
        <p className="text-xs text-zinc-500 mt-1">
          {year === 'pre-2024' ? 'Pre-2024' : '2024+'} catalog · {plannableCount} courses selected
        </p>
        <div className="mt-2 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div className="h-1.5 rounded-full bg-black dark:bg-white transition-all"
            style={{ width: `${requirements.length > 0 ? Math.min(100, (filledCount / requirements.length) * 100) : 0}%` }} />
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="max-h-[600px] overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800">
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
              <div key={id} className={`transition-colors border-l-4 ${isReqMet ? 'border-l-emerald-500 bg-white dark:bg-zinc-950' : currentSelections.length > 0 ? 'border-l-black dark:border-l-white bg-white dark:bg-zinc-950' : 'border-l-transparent bg-zinc-50/80 dark:bg-zinc-900/30'}`}>
                <button type="button" onClick={() => toggleExpand(id)}
                  className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
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
                      {visible.map((course, i) => {
                        const isCompleted = course.code ? isCourseCompleted(course.code) : false;
                        const isSelected = course.code ? currentSelections.includes(course.code) : false;

                        return (
                          <label key={`${id}-${course.code}-${i}`}
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
                  ? `Submit ${plannableCount} Course${plannableCount !== 1 ? 's' : ''}`
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
  description_rule?: string;
  notes?: string;
  courses?: { code: string; title: string; credits: number; prerequisite?: string; status?: string }[];
  subRequirements?: {
    requirementId: string;
    description: string;
    description_rule?: string;
    courses: { code: string; title: string; credits: number; prerequisite?: string; status?: string }[];
  }[];
  otherRequirement?: string;
}

function ProgramCourseSelectionForm({ tool, addToolOutput, sendMessage, planId, type, studentType, transcriptCourses: transcriptCoursesProp, onScaffoldUpdated, scaffoldChat, messages }: { tool: any; addToolOutput: any; sendMessage: any; planId: string; type: 'major' | 'minor' | 'graduate_no_gen_ed'; studentType: StudentType; transcriptCourses: any[]; onScaffoldUpdated?: (scaffold: any) => void; scaffoldChat?: any, messages: any[] }) {
  const programName: string = tool.args?.programName ?? '';
  const requirementsType = type === "graduate_no_gen_ed" ? "graduate_no_gen_ed" : type;
  const displayProgramLabel = type === "graduate_no_gen_ed" ? "Graduate Program" : type === "major" ? "Major" : "Minor";
  const scaffoldPhase = type === "minor" ? "minor" : "major";
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

  function parseSlotInfo(
    desc: string,
    courses: Array<{ credits: number }>,
    ruleDesc?: string
  ): { required: number; total: number; isHours: boolean; requiredHours: number; totalHours: number } {
    const totalHours = courses.reduce((sum, c) => sum + (c.credits || 0), 0);
    const parseText = [ruleDesc, desc]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ");

    // Prefer explicit hours semantics if present in rule text or label text.
    const nHours = parseText.match(/Complete\s+(\d+(?:\.\d+)?)\s*(?:Credit\s*)?Hours?/i);
    if (nHours) {
      const requiredHours = Number(nHours[1]);
      return {
        required: 0,
        total: totalHours,
        isHours: true,
        requiredHours,
        totalHours,
      };
    }

    // "Complete 1 of 3 Courses"
    const xOfY = parseText.match(/Complete\s+(\d+)\s+of\s+(\d+)\s+Course/i);
    if (xOfY) {
      return {
        required: parseInt(xOfY[1]),
        total: parseInt(xOfY[2]),
        isHours: false,
        requiredHours: 0,
        totalHours,
      };
    }

    // "Complete 6 Courses"
    const nCourses = parseText.match(/Complete\s+(\d+)\s+Course/i);
    if (nCourses) {
      return {
        required: parseInt(nCourses[1]),
        total: courses.length,
        isHours: false,
        requiredHours: 0,
        totalHours,
      };
    }

    // fallback
    return {
      required: 1,
      total: courses.length,
      isHours: false,
      requiredHours: 0,
      totalHours,
    };
  }

  function normCode(code: string): string {
    return code.replace(/\s+/g, '').toUpperCase();
  }

  // Helper: check if a course code appears in transcript
  function isCourseCompleted(code: string): boolean {
    return transcriptCodes.has(normCode(code));
  }

  function getSelectedHours(slot: { courses: { code: string; credits: number }[] }, selectedCodes: string[]): number {
    const selectedSet = new Set(selectedCodes);
    return slot.courses.reduce((sum, course) => (
      selectedSet.has(course.code) ? sum + (course.credits || 0) : sum
    ), 0);
  }

  function pickCoursesToReachHours(
    courses: { code: string; credits: number }[],
    targetHours: number
  ): string[] {
    const picked: string[] = [];
    let total = 0;
    for (const course of courses) {
      picked.push(course.code);
      total += course.credits || 0;
      if (total >= targetHours) break;
    }
    return picked;
  }

  function formatHours(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  useEffect(() => {
    if (!stableProgramName) return;
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    (async () => {
      try {
        const res = await fetch(`/api/program-requirements?program=${encodeURIComponent(stableProgramName)}&type=${requirementsType}`);
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
            const info = parseSlotInfo(slot.label, activeCourses, slot.ruleLabel);

            // Check transcript matches for this slot
            const transcriptMatches = activeCourses.filter(c => transcriptCodes.has(normCode(c.code)));

            if (info.isHours) {
              if (info.requiredHours >= info.totalHours) {
                autoSelections[slot.id] = activeCourses.map(c => c.code);
              } else {
                const transcriptHours = transcriptMatches.reduce((sum, c) => sum + (c.credits || 0), 0);
                if (transcriptHours >= info.requiredHours) {
                  autoSelections[slot.id] = pickCoursesToReachHours(transcriptMatches, info.requiredHours);
                } else if (transcriptMatches.length > 0) {
                  autoSelections[slot.id] = transcriptMatches.map(c => c.code);
                }
              }
            } else if (info.required === activeCourses.length) {
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
    const slots: { id: string; label: string; ruleLabel?: string; courses: NonNullable<ProgramReq['courses']> }[] = [];
    if (req.courses?.length) slots.push({
      id: String(req.requirementId),
      label: req.description,
      ruleLabel: req.description_rule,
      courses: req.courses
    });
    if (req.subRequirements) {
      for (const sub of req.subRequirements) {
        if (sub.courses?.length) slots.push({
          id: sub.requirementId,
          label: sub.description,
          ruleLabel: sub.description_rule,
          courses: sub.courses
        });
      }
    }
    return slots;
  }

  function requirementNeedsAttention(req: ProgramReq): boolean {
    for (const slot of getSlots(req)) {
      const activeCourses = slot.courses.filter(c => !c.status || c.status === 'active');
      const info = parseSlotInfo(slot.label, activeCourses, slot.ruleLabel);
      const selected = selections[slot.id] ?? [];
      if (info.isHours) {
        const selectedHours = getSelectedHours(slot, selected);
        if (selectedHours < info.requiredHours) return true;
      } else if (selected.length < info.required) {
        return true;
      }
    }
    return false;
  }

  useEffect(() => {
    if (requirements.length === 0) return;
    const idsNeedingAttention = requirements
      .filter(requirementNeedsAttention)
      .map((req) => String(req.requirementId));
    if (idsNeedingAttention.length === 0) return;

    setExpandedIds((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of idsNeedingAttention) {
        if (!next[id]) {
          next[id] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [requirements, selections]);

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

  const handleAutofill = () => {
    const newSelections = { ...selections };
    requirements.forEach(req => {
      for (const slot of getSlots(req)) {
        const activeCourses = slot.courses.filter(c => !c.status || c.status === 'active');
        const info = parseSlotInfo(slot.label, activeCourses, slot.ruleLabel);
        const currentSelections = newSelections[slot.id] || [];
        if (info.isHours) {
          const currentHours = getSelectedHours(slot, currentSelections);
          if (currentHours < info.requiredHours) {
            const available = activeCourses.filter(c => !currentSelections.includes(c.code));
            let runningHours = currentHours;
            const additions: string[] = [];
            for (const course of available) {
              additions.push(course.code);
              runningHours += course.credits || 0;
              if (runningHours >= info.requiredHours) break;
            }
            newSelections[slot.id] = [...currentSelections, ...additions];
          }
        } else {
          const current = currentSelections.length;
          if (current < info.required) {
            const toAdd = info.required - current;
            const available = activeCourses.filter(c => !currentSelections.includes(c.code));
            newSelections[slot.id] = [
              ...currentSelections,
              ...available.slice(0, toAdd).map(c => c.code)
            ];
          }
        }
      }
    });
    setSelections(newSelections);
  };

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
          if (c && !isCourseCompleted(c.code)) {
            selectedCourses.push({
              ...c,
              source: type === 'minor' ? 'minor' : 'major',
              requirementId: slot.id,
              requirementDescription: slot.label,
              fromTranscript: false,
            });
          }
        }
      }
    }

    // Fire async scaffold via streaming hook
    const preferences: any = getLatestPreferencesFromMessages(messages || []);

    if (scaffoldChat) {
      scaffoldChat.sendMessage(
        { text: `Please distribute ${type} courses into my plan` },
        { body: { planId, phase: scaffoldPhase, courses: selectedCourses, preferences } }
      );
    } else {
      fetch('/api/scaffold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId, phase: scaffoldPhase, courses: selectedCourses }) }).catch(console.error);
    }

    addToolOutput({ tool: tool.toolName, toolCallId: tool.toolCallId, output: { programName, selectedCourses, courseCount: selectedCourses.length } });

    const next = type === 'graduate_no_gen_ed'
      ? "[System: Graduate program course selections submitted. Do not call requestMinorSelection or selectGenEdCourses. Now build the graduation plan in the Playground: use `getRemainingCoursesToPlan`, `createTerm`, `addCoursesToTerm`, and `removeCourseFromTerm` to place all remaining courses. Run `checkPlanHeuristics`; if there are warnings or unplanned courses, fix them and re-run. Repeat until clean, then call `addMilestones`.]"
      : type === 'major'
        ? "[System: Major course selections submitted. Now immediately call requestMinorSelection - do not ask the user, just invoke the tool.]"
        : studentType === 'honors'
          ? "[System: Minor course selections submitted for an honors student. Now immediately call requestHonorsSelection - do not ask the user, just invoke the tool.]"
          : "[System: Minor course selections submitted. Now immediately call selectGenEdCourses - do not ask the user, just invoke the tool.]";
    sendMessage({ text: next });
  };

  const handleChooseDifferentMajor = () => {
    setSubmitted(true);
    addToolOutput({ tool: tool.toolName, toolCallId: tool.toolCallId, output: { action: "change_major" } });
    sendMessage({
      text: type === "graduate_no_gen_ed"
        ? `[System: User chose to change their graduate program selection while selecting courses for ${programName}. Now immediately call requestMajorSelection - do not ask the user, just invoke the tool.]`
        : `[System: User chose to change their major selection while selecting courses for ${programName}. Now immediately call requestMajorSelection - do not ask the user, just invoke the tool.]`
    });
  };

  const handleChooseDifferentMinor = () => {
    setSubmitted(true);
    addToolOutput({ tool: tool.toolName, toolCallId: tool.toolCallId, output: { action: "change_minor" } });
    sendMessage({
      text: `[System: User chose to change their minor selection while selecting courses for ${programName}. Now immediately call requestMinorSelection - do not ask the user, just invoke the tool.]`
    });
  };

  const handleContinueWithoutMinor = () => {
    setSubmitted(true);
    addToolOutput({ tool: tool.toolName, toolCallId: tool.toolCallId, output: { action: "skip_minor" } });
    sendMessage({
      text: studentType === "honors"
        ? `[System: User chose to continue without a minor while selecting courses for ${programName}. This student is honors-track, so now immediately call requestHonorsSelection - do not ask the user, just invoke the tool.]`
        : `[System: User chose to continue without a minor while selecting courses for ${programName}. Now immediately call selectGenEdCourses - do not ask the user, just invoke the tool.]`
    });
  };

  const filledCount = Object.values(selections).flat().filter(Boolean).length;
  const plannableFilledCount = requirements.reduce((total, req) => {
    let count = 0;
    for (const slot of getSlots(req)) {
      const codes = selections[slot.id] ?? [];
      for (const code of codes) {
        const c = slot.courses.find(x => x.code === code);
        if (c && !isCourseCompleted(c.code)) {
          count += 1;
        }
      }
    }
    return total + count;
  }, 0);
  const totalSlots = requirements.reduce((n, r) => n + getSlots(r).length, 0);

  // Compute whether every slot has met its required course count
  const unsatisfiedCount = requirements.reduce((n, req) => {
    for (const slot of getSlots(req)) {
      const activeCourses = slot.courses.filter(c => !c.status || c.status === 'active');
      const info = parseSlotInfo(slot.label, activeCourses, slot.ruleLabel);
      const selected = selections[slot.id] ?? [];
      if (info.isHours) {
        if (getSelectedHours(slot, selected) < info.requiredHours) n++;
      } else if (selected.length < info.required) {
        n++;
      }
    }
    return n;
  }, 0);
  const isFormComplete = requirements.length > 0 && unsatisfiedCount === 0;

  if (submitted) {
    return (
      <div className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-2 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 rounded-lg border border-emerald-100 dark:border-emerald-900/50">
        <CheckCircle2 size={14} />
        {displayProgramLabel} course selections submitted ({plannableFilledCount} courses)
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
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Select {displayProgramLabel} Courses</h3>
          {process.env.NEXT_PUBLIC_SHOW_DEBUG_TOOLS === 'true' && (
            <button type="button" onClick={handleAutofill} className="text-[10px] font-medium bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/50 dark:hover:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800 px-2.5 py-1 rounded shadow-sm transition-colors">
              Auto-fill (Dev)
            </button>
          )}
        </div>
        <p className="text-xs text-zinc-500 mt-1">{programName} &middot; {plannableFilledCount} courses selected</p>
        <div className="mt-2 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div className="h-1.5 rounded-full bg-black dark:bg-white transition-all" style={{ width: `${totalSlots > 0 ? Math.min(100, (filledCount / totalSlots) * 100) : 0}%` }} />
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="max-h-[500px] overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800">
          {requirements.map(req => {
            const id = String(req.requirementId);
            const isOpen = !!expandedIds[id];
            const needsAttention = requirementNeedsAttention(req);
            const slots = getSlots(req);

            return (
              <div key={id}>
                <button type="button" onClick={() => setExpandedIds(p => ({ ...p, [id]: !p[id] }))}
                  className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors">
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">{req.description}</span>
                    {needsAttention && (
                      <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full border border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                        Needs attention
                      </span>
                    )}
                  </div>
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
                      const info = parseSlotInfo(slot.label, activeCourses, slot.ruleLabel);
                      const q = searchQ[slot.id] ?? '';
                      const vis = q ? activeCourses.filter(c => c.code.toLowerCase().includes(q.toLowerCase()) || c.title.toLowerCase().includes(q.toLowerCase())) : activeCourses;
                      const sel = selections[slot.id] ?? [];
                      const isAutoAll = info.isHours ? info.requiredHours >= info.totalHours : info.required === activeCourses.length;
                      const selectedHours = info.isHours ? getSelectedHours(slot, sel) : 0;

                      // Check if requirement is fully fulfilled by transcript
                      const transcriptMatches = activeCourses.filter(c => isCourseCompleted(c.code));
                      const transcriptHours = transcriptMatches.reduce((sum, c) => sum + (c.credits || 0), 0);
                      const isFulfilledByTranscript = info.isHours
                        ? transcriptHours >= info.requiredHours
                        : transcriptMatches.length >= info.required;

                      return (
                        <div key={slot.id} className="space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{slot.ruleLabel || slot.label}</p>
                            {isAutoAll && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 font-medium">All required</span>
                            )}
                            {isFulfilledByTranscript && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 font-medium flex items-center gap-1">
                                <CheckCircle2 size={10} /> Requirement fulfilled
                              </span>
                            )}
                            {info.isHours && (
                              <span className="text-[10px] text-zinc-400">
                                ({formatHours(selectedHours)}/{formatHours(info.requiredHours)} hours selected)
                              </span>
                            )}
                            {!info.isHours && !isAutoAll && info.required > 1 && (
                              <span className="text-[10px] text-zinc-400">({sel.length}/{info.required} selected)</span>
                            )}
                          </div>

                          {activeCourses.length > 5 && (
                            <input type="text" placeholder="Search courses..." value={q}
                              onChange={e => setSearchQ(p => ({ ...p, [slot.id]: e.target.value }))}
                              className="w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white" />
                          )}
                          <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                            {vis.map((c, i) => {
                              const isSelected = sel.includes(c.code);
                              const isFromTranscript = isCourseCompleted(c.code);
                              const isDisabled = isAutoAll; // Can't deselect auto-all

                              return (
                                <label key={`${slot.id}-${c.code}-${i}`}
                                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-all text-xs ${isDisabled ? 'cursor-default' : 'cursor-pointer'} ${isSelected ? 'border-black bg-zinc-50 dark:border-white dark:bg-zinc-900' : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'}`}>
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    disabled={isDisabled}
                                    onChange={() => {
                                      if (isDisabled) return;
                                      if (!info.isHours && info.required === 1) {
                                        // Single-select: toggle off or replace
                                        setSelections(p => ({ ...p, [slot.id]: isSelected ? [] : [c.code] }));
                                      } else {
                                        toggleCourse(slot.id, c.code, info.isHours ? activeCourses.length : info.required);
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
              ? `Submit ${plannableFilledCount} Course${plannableFilledCount !== 1 ? 's' : ''}`
              : `${unsatisfiedCount} requirement${unsatisfiedCount !== 1 ? 's' : ''} left to fill`}
          </button>

          {type === "minor" ? (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40 p-3 space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Minor Decision
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleChooseDifferentMinor}
                  className="rounded-lg px-3 py-2.5 text-sm font-semibold transition-all border border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-300 dark:hover:bg-sky-950/50"
                >
                  Choose Different Minor
                </button>
                <button
                  type="button"
                  onClick={handleContinueWithoutMinor}
                  className="rounded-lg px-3 py-2.5 text-sm font-semibold transition-all border border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300 dark:hover:bg-rose-950/50"
                >
                  Continue Without Minor
                </button>
              </div>
            </div>
          ) : type === "major" || type === "graduate_no_gen_ed" ? (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40 p-3 space-y-2">
              <div>
                <button
                  type="button"
                  onClick={handleChooseDifferentMajor}
                  className="mx-auto block rounded-lg px-3 py-2.5 text-sm font-semibold transition-all border border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-300 dark:hover:bg-sky-950/50"
                >
                  {type === "graduate_no_gen_ed" ? "Choose Different Program" : "Choose Different Major"}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSubmitted(true);
                addToolOutput({ tool: tool.toolName, toolCallId: tool.toolCallId, output: { action: "skipped" } });
                sendMessage({ text: `[System: User chose to skip selecting courses for ${displayProgramLabel}. Check with them on how they want to proceed or move to the next step.]` });
              }}
              className="w-full rounded-xl py-3 text-sm font-medium transition-all text-zinc-500 hover:text-black dark:text-zinc-400 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Skip / Choose Something Else
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
