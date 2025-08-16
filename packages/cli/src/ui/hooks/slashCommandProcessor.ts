/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo } from 'react';
import { type PartListUnion } from '@google/genai';
import open from 'open';
import process from 'node:process';
import { UseHistoryManagerReturn } from './useHistoryManager.js';
import { useStateAndRef } from './useStateAndRef.js';
import {
  Config,
  GitService,
  Logger,
  MCPDiscoveryState,
  MCPServerStatus,
  getMCPDiscoveryState,
  getMCPServerStatus,
} from '@google/gemini-cli-core';
import { useSessionStats } from '../contexts/SessionContext.js';
import {
  Message,
  MessageType,
  HistoryItemWithoutId,
  HistoryItem,
} from '../types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { createShowMemoryAction } from './useShowMemoryCommand.js';
import { GIT_COMMIT_INFO } from '../../generated/git-commit.js';
import { formatDuration, formatMemoryUsage } from '../utils/formatters.js';
import { getCliVersion } from '../../utils/version.js';
import { LoadedSettings } from '../../config/settings.js';
import { SerialConsole } from '../../subsystems/serialConsole.js';
import { Worker } from 'node:worker_threads';
import { exec } from 'child_process';

// Allow other modules (useGeminiStream) to query current serial log length
export function getSerialLogLength(): number {
  return recentLogs.length;
}

export interface SlashCommandActionReturn {
  shouldScheduleTool?: boolean;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  message?: string; // For simple messages or errors
}

export interface SlashCommand {
  name: string;
  altName?: string;
  description?: string;
  completion?: () => Promise<string[]>;
  action: (
    mainCommand: string,
    subCommand?: string,
    args?: string,
  ) =>
    | void
    | SlashCommandActionReturn
    | Promise<void | SlashCommandActionReturn>; // Action can now return this object
}

let serial: SerialConsole | null = null;
let serialWorker: Worker | null = null;
let summaryBuf: string[] = [];
const SUMMARY_N_LINES = 50;
let serialHintShown = false;
// Ring buffer of recent lines for '/serial tail' command.
const LOG_RING_SIZE = 2000; // increased to ~2K lines at user's request
let recentLogs: string[] = [];
// Expose the live log ring so other packages (e.g. core tools) can inspect it.
(globalThis as any).GEMINI_SERIAL_LOGS = recentLogs;
let lastCommandStartIdx = 0; // index of log array when last serial send occurred
let partialSerialLine = ''; // accumulate chunk fragments until newline

function showSerialHint(addMessage: (msg: Message) => void) {
  if (!serialHintShown) {
    addMessage({
      type: MessageType.INFO,
      content: 'ℹ️  Serial logs are streaming in the "Serial Console" window; this pane stays quiet unless an error occurs.',
      timestamp: new Date(),
    });
    serialHintShown = true;
  }
}

/**
 * Hook to define and process slash commands (e.g., /help, /clear).
 */
export const useSlashCommandProcessor = (
  config: Config | null,
  settings: LoadedSettings,
  history: HistoryItem[],
  addItem: UseHistoryManagerReturn['addItem'],
  clearItems: UseHistoryManagerReturn['clearItems'],
  loadHistory: UseHistoryManagerReturn['loadHistory'],
  refreshStatic: () => void,
  setShowHelp: React.Dispatch<React.SetStateAction<boolean>>,
  onDebugMessage: (message: string) => void,
  openThemeDialog: () => void,
  openAuthDialog: () => void,
  openEditorDialog: () => void,
  performMemoryRefresh: () => Promise<void>,
  toggleCorgiMode: () => void,
  showToolDescriptions: boolean = false,
  setQuittingMessages: (message: HistoryItem[]) => void,
  openPrivacyNotice: () => void,
) => {
  const session = useSessionStats();
  const gitService = useMemo(() => {
    if (!config?.getProjectRoot()) {
      return;
    }
    return new GitService(config.getProjectRoot());
  }, [config]);

  const pendingHistoryItems: HistoryItemWithoutId[] = [];
  const [pendingCompressionItemRef, setPendingCompressionItem] =
    useStateAndRef<HistoryItemWithoutId | null>(null);
  if (pendingCompressionItemRef.current != null) {
    pendingHistoryItems.push(pendingCompressionItemRef.current);
  }

  const addMessage = useCallback(
    (message: Message) => {
      // Convert Message to HistoryItemWithoutId
      let historyItemContent: HistoryItemWithoutId;
      if (message.type === MessageType.ABOUT) {
        historyItemContent = {
          type: 'about',
          cliVersion: message.cliVersion,
          osVersion: message.osVersion,
          sandboxEnv: message.sandboxEnv,
          modelVersion: message.modelVersion,
          selectedAuthType: message.selectedAuthType,
          gcpProject: message.gcpProject,
        };
      } else if (message.type === MessageType.STATS) {
        historyItemContent = {
          type: 'stats',
          stats: message.stats,
          lastTurnStats: message.lastTurnStats,
          duration: message.duration,
        };
      } else if (message.type === MessageType.QUIT) {
        historyItemContent = {
          type: 'quit',
          stats: message.stats,
          duration: message.duration,
        };
      } else if (message.type === MessageType.COMPRESSION) {
        historyItemContent = {
          type: 'compression',
          compression: message.compression,
        };
      } else {
        historyItemContent = {
          type: message.type as
            | MessageType.INFO
            | MessageType.ERROR
            | MessageType.USER,
          text: message.content,
        };
      }
      addItem(historyItemContent, message.timestamp.getTime());
    },
    [addItem],
  );

  const showMemoryAction = useCallback(async () => {
    const actionFn = createShowMemoryAction(config, settings, addMessage);
    await actionFn();
  }, [config, settings, addMessage]);

  const addMemoryAction = useCallback(
    (
      _mainCommand: string,
      _subCommand?: string,
      args?: string,
    ): SlashCommandActionReturn | void => {
      if (!args || args.trim() === '') {
        addMessage({
          type: MessageType.ERROR,
          content: 'Usage: /memory add <text to remember>',
          timestamp: new Date(),
        });
        return;
      }
      // UI feedback for attempting to schedule
      addMessage({
        type: MessageType.INFO,
        content: `Attempting to save to memory: "${args.trim()}"`,
        timestamp: new Date(),
      });
      // Return info for scheduling the tool call
      return {
        shouldScheduleTool: true,
        toolName: 'save_memory',
        toolArgs: { fact: args.trim() },
      };
    },
    [addMessage],
  );

  const savedChatTags = useCallback(async () => {
    const geminiDir = config?.getProjectTempDir();
    if (!geminiDir) {
      return [];
    }
    try {
      const files = await fs.readdir(geminiDir);
      return files
        .filter(
          (file) => file.startsWith('checkpoint-') && file.endsWith('.json'),
        )
        .map((file) => file.replace('checkpoint-', '').replace('.json', ''));
    } catch (_err) {
      return [];
    }
  }, [config]);

  const slashCommands: SlashCommand[] = useMemo(() => {
    const commands: SlashCommand[] = [
      // ---------------- RAG Docs commands ----------------
      {
        name: 'rag',
        description: 'manage local documentation RAG store',
        action: async (_main, subCommand, args) => {
          const rag = await import('@google/gemini-cli-rag');
          const { ingest } = rag;
          const storeDir = path.join(config?.getProjectRoot() || process.cwd(), '.gemini', 'rag_store');
          const manifestPath = path.join(storeDir, 'chunks.jsonl');

          const ensureStoreExists = async () => {
            try {
              await fs.mkdir(storeDir, { recursive: true });
            } catch {}
          };

          switch (subCommand) {
            case 'add': {
              if (!args) {
                addMessage({ type: MessageType.ERROR, content: 'Usage: /rag add <file|dir> [--tag TAG[,TAG2]] [--watch]', timestamp: new Date() });
                return;
              }
              // crude arg parse
              const parts = args.split(/\s+/);
              const paths: string[] = [];
              const tags: string[] = [];
              let watch = false;
              for (let i = 0; i < parts.length; i++) {
                const p = parts[i];
                if (p === '--watch') watch = true;
                else if (p === '--tag') {
                  const tagStr = parts[i + 1] || '';
                  i++;
                  tags.push(...tagStr.split(',').map((t) => t.trim()).filter(Boolean));
                } else {
                  paths.push(p);
                }
              }
              if (paths.length === 0) {
                addMessage({ type: MessageType.ERROR, content: 'Specify at least one file or directory', timestamp: new Date() });
                return;
              }
              addMessage({ type: MessageType.INFO, content: `Ingesting ${paths.join(', ')} ...`, timestamp: new Date() });
              await ensureStoreExists();
              try {
                await ingest(paths, {
                  tag: tags,
                  watch,
                  config: config!,
                  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                  // @ts-ignore
                  progress: (msg: string) =>
                    addMessage({ type: MessageType.INFO, content: msg, timestamp: new Date() }),
                } as any);
                addMessage({ type: MessageType.INFO, content: 'Ingestion complete.', timestamp: new Date() });
              } catch (e) {
                addMessage({ type: MessageType.ERROR, content: `Ingest failed: ${(e as Error).message}`, timestamp: new Date() });
              }
              return;
            }
            case 'list': {
              await ensureStoreExists();
              let count = 0;
              let sources = new Set<string>();
              try {
                const data = await fs.readFile(manifestPath, 'utf8');
                for (const line of data.split(/\n+/)) {
                  if (!line.trim()) continue;
                  count++;
                  try {
                    const obj = JSON.parse(line);
                    if (obj?.metadata?.source) sources.add(obj.metadata.source);
                  } catch {}
                }
              } catch {}
              addMessage({ type: MessageType.INFO, content: `Docs store: ${count} chunks from ${sources.size} files`, timestamp: new Date() });
              return;
            }
            case 'status': {
              await ensureStoreExists();
              let mtime = 'unknown';
              try {
                const stat = await fs.stat(manifestPath);
                mtime = stat.mtime.toISOString();
              } catch {}
              addMessage({ type: MessageType.INFO, content: `RAG store path: ${storeDir}\nLast updated: ${mtime}`, timestamp: new Date() });
              return;
            }
            case 'clear': {
              try {
                await fs.rm(storeDir, { recursive: true, force: true });
                addMessage({ type: MessageType.INFO, content: 'RAG store cleared.', timestamp: new Date() });
              } catch (e) {
                addMessage({ type: MessageType.ERROR, content: `Failed to clear store: ${(e as Error).message}`, timestamp: new Date() });
              }
              return;
            }
            default:
              addMessage({ type: MessageType.INFO, content: 'Usage: /rag <add|list|status|clear|rebuild>', timestamp: new Date() });
          }
        },
      },
      {
        name: 'help',
        altName: '?',
        description: 'for help on gemini-cli',
        action: (_mainCommand, _subCommand, _args) => {
          onDebugMessage('Opening help.');
          setShowHelp(true);
        },
      },
      {
        name: 'docs',
        description: 'open full Gemini CLI documentation in your browser',
        action: async (_mainCommand, _subCommand, _args) => {
          const docsUrl = 'https://goo.gle/gemini-cli-docs';
          if (process.env.SANDBOX && process.env.SANDBOX !== 'sandbox-exec') {
            addMessage({
              type: MessageType.INFO,
              content: `Please open the following URL in your browser to view the documentation:\n${docsUrl}`,
              timestamp: new Date(),
            });
          } else {
            addMessage({
              type: MessageType.INFO,
              content: `Opening documentation in your browser: ${docsUrl}`,
              timestamp: new Date(),
            });
            await open(docsUrl);
          }
        },
      },
      {
        name: 'clear',
        description: 'clear the screen and conversation history',
        action: async (_mainCommand, _subCommand, _args) => {
          onDebugMessage('Clearing terminal and resetting chat.');
          clearItems();
          await config?.getGeminiClient()?.resetChat();
          console.clear();
          refreshStatic();
        },
      },
      {
        name: 'theme',
        description: 'change the theme',
        action: (_mainCommand, _subCommand, _args) => {
          openThemeDialog();
        },
      },
      {
        name: 'auth',
        description: 'change the auth method',
        action: (_mainCommand, _subCommand, _args) => {
          openAuthDialog();
        },
      },
      {
        name: 'editor',
        description: 'set external editor preference',
        action: (_mainCommand, _subCommand, _args) => {
          openEditorDialog();
        },
      },
      {
        name: 'privacy',
        description: 'display the privacy notice',
        action: (_mainCommand, _subCommand, _args) => {
          openPrivacyNotice();
        },
      },
      {
        name: 'stats',
        altName: 'usage',
        description: 'check session stats',
        action: (_mainCommand, _subCommand, _args) => {
          const now = new Date();
          const { sessionStartTime, cumulative, currentTurn } = session.stats;
          const wallDuration = now.getTime() - sessionStartTime.getTime();

          addMessage({
            type: MessageType.STATS,
            stats: cumulative,
            lastTurnStats: currentTurn,
            duration: formatDuration(wallDuration),
            timestamp: new Date(),
          });
        },
      },
      {
        name: 'mcp',
        description: 'list configured MCP servers and tools',
        action: async (_mainCommand, _subCommand, _args) => {
          // Check if the _subCommand includes a specific flag to control description visibility
          let useShowDescriptions = showToolDescriptions;
          if (_subCommand === 'desc' || _subCommand === 'descriptions') {
            useShowDescriptions = true;
          } else if (
            _subCommand === 'nodesc' ||
            _subCommand === 'nodescriptions'
          ) {
            useShowDescriptions = false;
          } else if (_args === 'desc' || _args === 'descriptions') {
            useShowDescriptions = true;
          } else if (_args === 'nodesc' || _args === 'nodescriptions') {
            useShowDescriptions = false;
          }
          // Check if the _subCommand includes a specific flag to show detailed tool schema
          let useShowSchema = false;
          if (_subCommand === 'schema' || _args === 'schema') {
            useShowSchema = true;
          }

          const toolRegistry = await config?.getToolRegistry();
          if (!toolRegistry) {
            addMessage({
              type: MessageType.ERROR,
              content: 'Could not retrieve tool registry.',
              timestamp: new Date(),
            });
            return;
          }

          const mcpServers = config?.getMcpServers() || {};
          const serverNames = Object.keys(mcpServers);

          if (serverNames.length === 0) {
            const docsUrl = 'https://goo.gle/gemini-cli-docs-mcp';
            if (process.env.SANDBOX && process.env.SANDBOX !== 'sandbox-exec') {
              addMessage({
                type: MessageType.INFO,
                content: `No MCP servers configured. Please open the following URL in your browser to view documentation:\n${docsUrl}`,
                timestamp: new Date(),
              });
            } else {
              addMessage({
                type: MessageType.INFO,
                content: `No MCP servers configured. Opening documentation in your browser: ${docsUrl}`,
                timestamp: new Date(),
              });
              await open(docsUrl);
            }
            return;
          }

          // Check if any servers are still connecting
          const connectingServers = serverNames.filter(
            (name) => getMCPServerStatus(name) === MCPServerStatus.CONNECTING,
          );
          const discoveryState = getMCPDiscoveryState();

          let message = '';

          // Add overall discovery status message if needed
          if (
            discoveryState === MCPDiscoveryState.IN_PROGRESS ||
            connectingServers.length > 0
          ) {
            message += `\u001b[33m⏳ MCP servers are starting up (${connectingServers.length} initializing)...\u001b[0m\n`;
            message += `\u001b[90mNote: First startup may take longer. Tool availability will update automatically.\u001b[0m\n\n`;
          }

          message += 'Configured MCP servers:\n\n';

          for (const serverName of serverNames) {
            const serverTools = toolRegistry.getToolsByServer(serverName);
            const status = getMCPServerStatus(serverName);

            // Add status indicator with descriptive text
            let statusIndicator = '';
            let statusText = '';
            switch (status) {
              case MCPServerStatus.CONNECTED:
                statusIndicator = '🟢';
                statusText = 'Ready';
                break;
              case MCPServerStatus.CONNECTING:
                statusIndicator = '🔄';
                statusText = 'Starting... (first startup may take longer)';
                break;
              case MCPServerStatus.DISCONNECTED:
              default:
                statusIndicator = '🔴';
                statusText = 'Disconnected';
                break;
            }

            // Get server description if available
            const server = mcpServers[serverName];

            // Format server header with bold formatting and status
            message += `${statusIndicator} \u001b[1m${serverName}\u001b[0m - ${statusText}`;

            // Add tool count with conditional messaging
            if (status === MCPServerStatus.CONNECTED) {
              message += ` (${serverTools.length} tools)`;
            } else if (status === MCPServerStatus.CONNECTING) {
              message += ` (tools will appear when ready)`;
            } else {
              message += ` (${serverTools.length} tools cached)`;
            }

            // Add server description with proper handling of multi-line descriptions
            if ((useShowDescriptions || useShowSchema) && server?.description) {
              const greenColor = '\u001b[32m';
              const resetColor = '\u001b[0m';

              const descLines = server.description.trim().split('\n');
              if (descLines) {
                message += ':\n';
                for (let i = 0; i < descLines.length; i++) {
                  message += `    ${greenColor}${descLines[i]}${resetColor}\n`;
                }
              } else {
                message += '\n';
              }
            } else {
              message += '\n';
            }

            // Reset formatting after server entry
            message += '\u001b[0m';

            if (serverTools.length > 0) {
              serverTools.forEach((tool) => {
                if (
                  (useShowDescriptions || useShowSchema) &&
                  tool.description
                ) {
                  // Format tool name in cyan using simple ANSI cyan color
                  message += `  - \u001b[36m${tool.name}\u001b[0m`;

                  // Apply green color to the description text
                  const greenColor = '\u001b[32m';
                  const resetColor = '\u001b[0m';

                  // Handle multi-line descriptions by properly indenting and preserving formatting
                  const descLines = tool.description.trim().split('\n');
                  if (descLines) {
                    message += ':\n';
                    for (let i = 0; i < descLines.length; i++) {
                      message += `      ${greenColor}${descLines[i]}${resetColor}\n`;
                    }
                  } else {
                    message += '\n';
                  }
                  // Reset is handled inline with each line now
                } else {
                  // Use cyan color for the tool name even when not showing descriptions
                  message += `  - \u001b[36m${tool.name}\u001b[0m\n`;
                }
                if (useShowSchema) {
                  // Prefix the parameters in cyan
                  message += `    \u001b[36mParameters:\u001b[0m\n`;
                  // Apply green color to the parameter text
                  const greenColor = '\u001b[32m';
                  const resetColor = '\u001b[0m';

                  const paramsLines = JSON.stringify(
                    tool.schema.parameters,
                    null,
                    2,
                  )
                    .trim()
                    .split('\n');
                  if (paramsLines) {
                    for (let i = 0; i < paramsLines.length; i++) {
                      message += `      ${greenColor}${paramsLines[i]}${resetColor}\n`;
                    }
                  }
                }
              });
            } else {
              message += '  No tools available\n';
            }
            message += '\n';
          }

          // Make sure to reset any ANSI formatting at the end to prevent it from affecting the terminal
          message += '\u001b[0m';

          addMessage({
            type: MessageType.INFO,
            content: message,
            timestamp: new Date(),
          });
        },
      },
      {
        name: 'memory',
        description:
          'manage memory. Usage: /memory <show|refresh|add> [text for add]',
        action: (mainCommand, subCommand, args) => {
          switch (subCommand) {
            case 'show':
              showMemoryAction();
              return;
            case 'refresh':
              performMemoryRefresh();
              return;
            case 'add':
              return addMemoryAction(mainCommand, subCommand, args); // Return the object
            case undefined:
              addMessage({
                type: MessageType.ERROR,
                content:
                  'Missing command\nUsage: /memory <show|refresh|add> [text for add]',
                timestamp: new Date(),
              });
              return;
            default:
              addMessage({
                type: MessageType.ERROR,
                content: `Unknown /memory command: ${subCommand}. Available: show, refresh, add`,
                timestamp: new Date(),
              });
              return;
          }
        },
      },
      {
        name: 'tools',
        description: 'list available Gemini CLI tools',
        action: async (_mainCommand, _subCommand, _args) => {
          // Check if the _subCommand includes a specific flag to control description visibility
          let useShowDescriptions = showToolDescriptions;
          if (_subCommand === 'desc' || _subCommand === 'descriptions') {
            useShowDescriptions = true;
          } else if (
            _subCommand === 'nodesc' ||
            _subCommand === 'nodescriptions'
          ) {
            useShowDescriptions = false;
          } else if (_args === 'desc' || _args === 'descriptions') {
            useShowDescriptions = true;
          } else if (_args === 'nodesc' || _args === 'nodescriptions') {
            useShowDescriptions = false;
          }

          const toolRegistry = await config?.getToolRegistry();
          const tools = toolRegistry?.getAllTools();
          if (!tools) {
            addMessage({
              type: MessageType.ERROR,
              content: 'Could not retrieve tools.',
              timestamp: new Date(),
            });
            return;
          }

          // Filter out MCP tools by checking if they have a serverName property
          const geminiTools = tools.filter((tool) => !('serverName' in tool));

          let message = 'Available Gemini CLI tools:\n\n';

          if (geminiTools.length > 0) {
            geminiTools.forEach((tool) => {
              if (useShowDescriptions && tool.description) {
                // Format tool name in cyan using simple ANSI cyan color
                message += `  - \u001b[36m${tool.displayName} (${tool.name})\u001b[0m:\n`;

                // Apply green color to the description text
                const greenColor = '\u001b[32m';
                const resetColor = '\u001b[0m';

                // Handle multi-line descriptions by properly indenting and preserving formatting
                const descLines = tool.description.trim().split('\n');

                // If there are multiple lines, add proper indentation for each line
                if (descLines) {
                  for (let i = 0; i < descLines.length; i++) {
                    message += `      ${greenColor}${descLines[i]}${resetColor}\n`;
                  }
                }
              } else {
                // Use cyan color for the tool name even when not showing descriptions
                message += `  - \u001b[36m${tool.displayName}\u001b[0m\n`;
              }
            });
          } else {
            message += '  No tools available\n';
          }
          message += '\n';

          // Make sure to reset any ANSI formatting at the end to prevent it from affecting the terminal
          message += '\u001b[0m';

          addMessage({
            type: MessageType.INFO,
            content: message,
            timestamp: new Date(),
          });
        },
      },
      {
        name: 'corgi',
        action: (_mainCommand, _subCommand, _args) => {
          toggleCorgiMode();
        },
      },
      {
        name: 'about',
        description: 'show version info',
        action: async (_mainCommand, _subCommand, _args) => {
          const osVersion = process.platform;
          let sandboxEnv = 'no sandbox';
          if (process.env.SANDBOX && process.env.SANDBOX !== 'sandbox-exec') {
            sandboxEnv = process.env.SANDBOX;
          } else if (process.env.SANDBOX === 'sandbox-exec') {
            sandboxEnv = `sandbox-exec (${
              process.env.SEATBELT_PROFILE || 'unknown'
            })`;
          }
          const modelVersion = config?.getModel() || 'Unknown';
          const cliVersion = await getCliVersion();
          const selectedAuthType = settings.merged.selectedAuthType || '';
          const gcpProject = process.env.GOOGLE_CLOUD_PROJECT || '';
          addMessage({
            type: MessageType.ABOUT,
            timestamp: new Date(),
            cliVersion,
            osVersion,
            sandboxEnv,
            modelVersion,
            selectedAuthType,
            gcpProject,
          });
        },
      },
      {
        name: 'bug',
        description: 'submit a bug report',
        action: async (_mainCommand, _subCommand, args) => {
          let bugDescription = _subCommand || '';
          if (args) {
            bugDescription += ` ${args}`;
          }
          bugDescription = bugDescription.trim();

          const osVersion = `${process.platform} ${process.version}`;
          let sandboxEnv = 'no sandbox';
          if (process.env.SANDBOX && process.env.SANDBOX !== 'sandbox-exec') {
            sandboxEnv = process.env.SANDBOX.replace(/^gemini-(?:code-)?/, '');
          } else if (process.env.SANDBOX === 'sandbox-exec') {
            sandboxEnv = `sandbox-exec (${
              process.env.SEATBELT_PROFILE || 'unknown'
            })`;
          }
          const modelVersion = config?.getModel() || 'Unknown';
          const cliVersion = await getCliVersion();
          const memoryUsage = formatMemoryUsage(process.memoryUsage().rss);

          const info = `
*   **CLI Version:** ${cliVersion}
*   **Git Commit:** ${GIT_COMMIT_INFO}
*   **Operating System:** ${osVersion}
*   **Sandbox Environment:** ${sandboxEnv}
*   **Model Version:** ${modelVersion}
*   **Memory Usage:** ${memoryUsage}
`;

          let bugReportUrl =
            'https://github.com/google-gemini/gemini-cli/issues/new?template=bug_report.yml&title={title}&info={info}';
          const bugCommand = config?.getBugCommand();
          if (bugCommand?.urlTemplate) {
            bugReportUrl = bugCommand.urlTemplate;
          }
          bugReportUrl = bugReportUrl
            .replace('{title}', encodeURIComponent(bugDescription))
            .replace('{info}', encodeURIComponent(info));

          addMessage({
            type: MessageType.INFO,
            content: `To submit your bug report, please open the following URL in your browser:\n${bugReportUrl}`,
            timestamp: new Date(),
          });
          (async () => {
            try {
              await open(bugReportUrl);
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              addMessage({
                type: MessageType.ERROR,
                content: `Could not open URL in browser: ${errorMessage}`,
                timestamp: new Date(),
              });
            }
          })();
        },
      },
      {
        name: 'chat',
        description:
          'Manage conversation history. Usage: /chat <list|save|resume> [tag]',
        action: async (_mainCommand, subCommand, args) => {
          const tag = (args || '').trim();
          const logger = new Logger(config?.getSessionId() || '');
          await logger.initialize();
          const chat = await config?.getGeminiClient()?.getChat();
          if (!chat) {
            addMessage({
              type: MessageType.ERROR,
              content: 'No chat client available for conversation status.',
              timestamp: new Date(),
            });
            return;
          }
          if (!subCommand) {
            addMessage({
              type: MessageType.ERROR,
              content: 'Missing command\nUsage: /chat <list|save|resume> [tag]',
              timestamp: new Date(),
            });
            return;
          }
          switch (subCommand) {
            case 'save': {
              const history = chat.getHistory();
              if (history.length > 0) {
                await logger.saveCheckpoint(chat?.getHistory() || [], tag);
                addMessage({
                  type: MessageType.INFO,
                  content: `Conversation checkpoint saved${tag ? ' with tag: ' + tag : ''}.`,
                  timestamp: new Date(),
                });
              } else {
                addMessage({
                  type: MessageType.INFO,
                  content: 'No conversation found to save.',
                  timestamp: new Date(),
                });
              }
              return;
            }
            case 'resume':
            case 'restore':
            case 'load': {
              const conversation = await logger.loadCheckpoint(tag);
              if (conversation.length === 0) {
                addMessage({
                  type: MessageType.INFO,
                  content: `No saved checkpoint found${tag ? ' with tag: ' + tag : ''}.`,
                  timestamp: new Date(),
                });
                return;
              }

              clearItems();
              chat.clearHistory();
              const rolemap: { [key: string]: MessageType } = {
                user: MessageType.USER,
                model: MessageType.GEMINI,
              };
              let hasSystemPrompt = false;
              let i = 0;
              for (const item of conversation) {
                i += 1;

                // Add each item to history regardless of whether we display
                // it.
                chat.addHistory(item);

                const text =
                  item.parts
                    ?.filter((m) => !!m.text)
                    .map((m) => m.text)
                    .join('') || '';
                if (!text) {
                  // Parsing Part[] back to various non-text output not yet implemented.
                  continue;
                }
                if (i === 1 && text.match(/context for our chat/)) {
                  hasSystemPrompt = true;
                }
                if (i > 2 || !hasSystemPrompt) {
                  addItem(
                    {
                      type:
                        (item.role && rolemap[item.role]) || MessageType.GEMINI,
                      text,
                    } as HistoryItemWithoutId,
                    i,
                  );
                }
              }
              console.clear();
              refreshStatic();
              return;
            }
            case 'list':
              addMessage({
                type: MessageType.INFO,
                content:
                  'list of saved conversations: ' +
                  (await savedChatTags()).join(', '),
                timestamp: new Date(),
              });
              return;
            default:
              addMessage({
                type: MessageType.ERROR,
                content: `Unknown /chat command: ${subCommand}. Available: list, save, resume`,
                timestamp: new Date(),
              });
              return;
          }
        },
        completion: async () =>
          (await savedChatTags()).map((tag) => 'resume ' + tag),
      },
      {
        name: 'quit',
        altName: 'exit',
        description: 'exit the cli',
        action: async (mainCommand, _subCommand, _args) => {
          const now = new Date();
          const { sessionStartTime, cumulative } = session.stats;
          const wallDuration = now.getTime() - sessionStartTime.getTime();

          setQuittingMessages([
            {
              type: 'user',
              text: `/${mainCommand}`,
              id: now.getTime() - 1,
            },
            {
              type: 'quit',
              stats: cumulative,
              duration: formatDuration(wallDuration),
              id: now.getTime(),
            },
          ]);

          setTimeout(() => {
            process.exit(0);
          }, 100);
        },
      },
      {
        name: 'compress',
        altName: 'summarize',
        description: 'Compresses the context by replacing it with a summary.',
        action: async (_mainCommand, _subCommand, _args) => {
          if (pendingCompressionItemRef.current !== null) {
            addMessage({
              type: MessageType.ERROR,
              content:
                'Already compressing, wait for previous request to complete',
              timestamp: new Date(),
            });
            return;
          }
          setPendingCompressionItem({
            type: MessageType.COMPRESSION,
            compression: {
              isPending: true,
              originalTokenCount: null,
              newTokenCount: null,
            },
          });
          try {
            const compressed = await config!
              .getGeminiClient()!
              .tryCompressChat(true);
            if (compressed) {
              addMessage({
                type: MessageType.COMPRESSION,
                compression: {
                  isPending: false,
                  originalTokenCount: compressed.originalTokenCount,
                  newTokenCount: compressed.newTokenCount,
                },
                timestamp: new Date(),
              });
            } else {
              addMessage({
                type: MessageType.ERROR,
                content: 'Failed to compress chat history.',
                timestamp: new Date(),
              });
            }
          } catch (e) {
            addMessage({
              type: MessageType.ERROR,
              content: `Failed to compress chat history: ${e instanceof Error ? e.message : String(e)}`,
              timestamp: new Date(),
            });
          }
          setPendingCompressionItem(null);
        },
      },
      {
        name: 'serial',
        description: 'Serial console: /serial connect <port> <baud>, /serial send <cmd>, /serial prompt <natural prompt>, /serial disconnect',
        action: async (_mainCommand, subCommand, args) => {
          if (subCommand === 'connect') {
            serialHintShown = false;
            const [port, baudStr] = (args || '').split(' ');
            const baud = baudStr ? parseInt(baudStr, 10) : 115200;
            if (serial) serial.disconnect();
            if (serialWorker) {
              try {
                serialWorker.postMessage({ type: 'quit' });
                await serialWorker.terminate();
              } catch {
                /* ignore */
              }
              serialWorker = null;
            }
            serial = new SerialConsole();
            // Spawn PipeWriter worker that manages TerminalSpooler in a separate thread.
            const workerUrl = new URL('../../subsystems/pipeWriter.js', import.meta.url);
            // @ts-ignore Node typings may not yet include 'type' in WorkerOptions.
            serialWorker = new Worker(workerUrl, {
              workerData: { path: port, baudRate: baud, windowTitle: `Serial: ${port}@${baud}` },
              type: 'module',
            } as any);
            serial.on('open', () => addMessage({ type: MessageType.INFO, content: `Serial connected to ${port} at ${baud} baud.`, timestamp: new Date() }));
            serial.on('data', (data: string) => {
              showSerialHint(addMessage);
              serialWorker?.postMessage({ type: 'line', data });

              // Robust line assembly: accumulate until newline.
              partialSerialLine += data;
              let newlineIdx: number;
              while ((newlineIdx = partialSerialLine.search(/\r?\n/)) !== -1) {
                const line = partialSerialLine.slice(0, newlineIdx).trimEnd();
                partialSerialLine = partialSerialLine.slice(newlineIdx + (partialSerialLine[newlineIdx] === '\r' && partialSerialLine[newlineIdx + 1] === '\n' ? 2 : 1));
                if (line.length > 0) {
                  recentLogs.push(line);
                  if (recentLogs.length > LOG_RING_SIZE) {
                    const excess = recentLogs.length - LOG_RING_SIZE;
                    // Remove oldest entries in-place to preserve the same array reference
                    recentLogs.splice(0, excess);
                    // Adjust saved index so it still refers to same logical point
                    lastCommandStartIdx = Math.max(0, lastCommandStartIdx - excess);
                  }
                }
              }
              summaryBuf.push(data);
              if (summaryBuf.length >= SUMMARY_N_LINES) {
                const chunk = summaryBuf.join('\n');
                summaryBuf.length = 0;
                // TODO: summarizer
              }
            });
            serial.on('error', (err: Error) => addMessage({ type: MessageType.ERROR, content: `Serial error: ${err.message}`, timestamp: new Date() }));
            serial.on('close', () => addMessage({ type: MessageType.INFO, content: 'Serial disconnected.', timestamp: new Date() }));
            serial.connect(port, baud);
            // Save active serial port so other tools (e.g., get_device_info) can reuse it.
            process.env.GEMINI_SERIAL_PORT = port;
            // Expose serial object globally so core tools can reuse the existing session.
            (globalThis as any).GEMINI_ACTIVE_SERIAL = serial;

            const attachWorkerListeners = () => {
              if (!serialWorker) return;
              serialWorker.on('message', (msg: { type: string; message?: string }) => {
                if (msg.type === 'error') {
                  addMessage({ type: MessageType.ERROR, content: `Serial console worker error: ${msg.message}`, timestamp: new Date() });
                } else if (msg.type === 'ready') {
                  addMessage({ type: MessageType.INFO, content: 'Serial console window opened.', timestamp: new Date() });
                }
              });
              serialWorker.on('error', (err: Error) => {
                addMessage({ type: MessageType.ERROR, content: `Serial console worker failed: ${err.message}. Falling back to inline logs.`, timestamp: new Date() });
                serialWorker = null;
              });
              serialWorker.on('exit', (code) => {
                if (code !== 0) {
                  addMessage({ type: MessageType.ERROR, content: `Serial console worker exited with code ${code}`, timestamp: new Date() });
                }
              });
            };
            attachWorkerListeners();
          } else if (subCommand === 'tail') {
            const n = args ? parseInt(args, 10) || 20 : 20;
            const output = recentLogs.slice(-n).join('\n');
            addMessage({ type: MessageType.INFO, content: `Last ${n} serial lines:\n\n${output}`, timestamp: new Date() });
          } else if (subCommand === 'summarize') {
            let startIdx = lastCommandStartIdx;
            let summaryQuery = args?.trim() || 'a concise summary';
            const firstWord = summaryQuery.split(/\s+/)[0];
            if (/^\d+$/.test(firstWord)) {
              startIdx = parseInt(firstWord, 10);
              summaryQuery = summaryQuery.substring(firstWord.length).trim() || 'a concise summary';
            }
            if (startIdx < 0 || startIdx >= recentLogs.length) startIdx = 0;

            const logsToSummarize = recentLogs.slice(startIdx).join('\n');
            const linesCount = logsToSummarize.split(/\n/).length;

            // Debug preview
            const previewLines = logsToSummarize.split(/\n/).slice(0, 20).join('\n');
            addMessage({
              type: MessageType.INFO,
              content: `Debug: summarizing from index ${startIdx}. Total lines=${linesCount}. Preview:\n\n${previewLines}`,
              timestamp: new Date(),
            });

            addMessage({ type: MessageType.INFO, content: `Summarizing ${linesCount} captured lines ...`, timestamp: new Date() });

            try {
              const geminiClient = config?.getGeminiClient();
              if (!geminiClient) throw new Error('Gemini client not available');

              const prompt = `
You are a strict log-analyser. 
Answer the user’s query **only** with facts you can derive
from the lines below. If the answer is not present, reply
“Information not found in the provided output.”

User query: ${summaryQuery}

Log snippet:
\`\`\`
${logsToSummarize}
\`\`\`
`.trim();

              const response = await geminiClient.generateContent(
                [{ role: 'user', parts: [{ text: prompt }] }],
                {},                       // optional generation config
                new AbortController().signal
              );
              const summaryText = response.text || '(No summary returned)';

              addMessage({ type: MessageType.INFO, content: summaryText, timestamp: new Date() });
            } catch (err) {
              addMessage({ type: MessageType.ERROR, content: `Failed to summarize logs: ${(err as Error).message}`, timestamp: new Date() });
            }
          } else if (subCommand === 'clear') {
            recentLogs.length = 0; // maintain same array reference
            addMessage({ type: MessageType.INFO, content: 'Serial log buffer cleared.', timestamp: new Date() });
          } else if (subCommand === 'send' && serial) {
            // mark start index before sending
            lastCommandStartIdx = recentLogs.length;
            if (args) {
              serialWorker?.postMessage({ type: 'line', data: `> ${args}\n` });
            }
            serial.send(args || '');
          } else if (subCommand === 'prompt' || subCommand === 'ask' || subCommand === 'query') {
            // New feature: interpret natural-language prompt → shell command → serial → summary
            if (!serial) {
              addMessage({
                type: MessageType.ERROR,
                content: 'Serial not connected. Use /serial connect first.',
                timestamp: new Date(),
              });
              return;
            }
            if (!args || args.trim().length === 0) {
              addMessage({
                type: MessageType.ERROR,
                content: 'Usage: /serial prompt <natural language request>',
                timestamp: new Date(),
              });
              return;
            }

            const nlPrompt = args.trim();
            addMessage({
              type: MessageType.INFO,
              content: `Interpreting request: "${nlPrompt}"`,
              timestamp: new Date(),
            });

            const geminiClient = config?.getGeminiClient();
            let generatedCmd = '';
            let cmdDescription = '';
            try {
              if (geminiClient) {
                const schema = {
                  type: 'object',
                  properties: {
                    command: {
                      type: 'string',
                      description: 'Shell command to execute that satisfies the request.',
                    },
                    description: {
                      type: 'string',
                      description: 'Brief one-sentence description of what the command does.',
                    },
                  },
                  required: ['command'],
                } as const;

                const controller = new AbortController();
                const jsonResp = (await geminiClient.generateJson(
                  [
                    {
                      role: 'user',
                      parts: [
                        {
                          text: [
                            'You are an expert Linux shell assistant running on an embedded device.',
                            'Translate the following natural language request into a **single** safe POSIX-compatible shell command.',
                            'Return a JSON object that matches the given schema and do **not** include any extra keys or comments.',
                            `Request: "${nlPrompt}"`,
                          ].join('\n'),
                        },
                      ],
                    },
                  ],
                  schema,
                  controller.signal,
                )) as unknown as { command: string; description?: string };

                generatedCmd = (jsonResp.command || '').trim();
                cmdDescription = (jsonResp.description || '').trim();
              }
            } catch (err) {
              // Ignore model failures; fallback to heuristic.
            }

            // Simple heuristic fallbacks for common queries
            if (!generatedCmd) {
              const l = nlPrompt.toLowerCase();
              if (l.includes('usb')) generatedCmd = 'lsusb';
              else if (l.includes('cpu') && l.includes('usage'))
                generatedCmd = 'top -bn1 | head -n 20';
              else if (l.includes('disk') && (l.includes('space') || l.includes('usage')))
                generatedCmd = 'df -h';
              else if (l.includes('memory') && l.includes('usage'))
                generatedCmd = 'free -h';
              else if (l.includes('process') && l.includes('list'))
                generatedCmd = 'ps aux';
            }

            if (!generatedCmd) {
              addMessage({
                type: MessageType.ERROR,
                content: 'Failed to derive a shell command from the request.',
                timestamp: new Date(),
              });
              return;
            }

            addMessage({
              type: MessageType.INFO,
              content: `Generated command: ${generatedCmd}${cmdDescription ? ` \u2014 ${cmdDescription}` : ''}`,
              timestamp: new Date(),
            });

            // Send command via serial
            lastCommandStartIdx = recentLogs.length;
            serialWorker?.postMessage({ type: 'line', data: `> ${generatedCmd}\n` });
            serial.send(generatedCmd);

            // After a short delay, summarize the output for the user.
            setTimeout(async () => {
              try {
                const logsToSummarize = recentLogs
                  .slice(lastCommandStartIdx)
                  .join('\n');
                if (!logsToSummarize.trim()) return;

                const summarizerPrompt = [
                  'Provide a concise, user-friendly summary of the following command output.',
                  'Focus on the key information the user asked for and avoid raw logs.',
                  '\nOUTPUT:\n',
                  logsToSummarize,
                ].join('\n');

                if (!geminiClient) return;
                const response = await geminiClient.generateContent(
                  [{ role: 'user', parts: [{ text: summarizerPrompt }] }],
                  {},
                  new AbortController().signal,
                );
                const summaryText = response.text || '(No summary returned)';
                addMessage({
                  type: MessageType.INFO,
                  content: summaryText,
                  timestamp: new Date(),
                });
              } catch (e) {
                addMessage({
                  type: MessageType.ERROR,
                  content: `Failed to summarize output: ${(e as Error).message}`,
                  timestamp: new Date(),
                });
              }
            }, 800);
          } else if (subCommand === 'disconnect') {
            if (serial) serial.disconnect();
            if (serialWorker) {
              try {
                serialWorker.postMessage({ type: 'quit' });
                await serialWorker.terminate();
              } catch {
                /* ignore */
              }
              serialWorker = null;
            }
            // Clear saved serial port environment variable.
            delete process.env.GEMINI_SERIAL_PORT;
            delete (globalThis as any).GEMINI_ACTIVE_SERIAL;
            serialHintShown = false;
            addMessage({ type: MessageType.INFO, content: 'Serial disconnected; window closed', timestamp: new Date() });
          } else {
            addMessage({ type: MessageType.ERROR, content: 'Usage: /serial connect <port> <baud>, /serial send <cmd>, /serial disconnect', timestamp: new Date() });
          }
        }
      },
    ];

    if (config?.getCheckpointingEnabled()) {
      commands.push({
        name: 'restore',
        description:
          'restore a tool call. This will reset the conversation and file history to the state it was in when the tool call was suggested',
        completion: async () => {
          const checkpointDir = config?.getProjectTempDir()
            ? path.join(config.getProjectTempDir(), 'checkpoints')
            : undefined;
          if (!checkpointDir) {
            return [];
          }
          try {
            const files = await fs.readdir(checkpointDir);
            return files
              .filter((file) => file.endsWith('.json'))
              .map((file) => file.replace('.json', ''));
          } catch (_err) {
            return [];
          }
        },
        action: async (_mainCommand, subCommand, _args) => {
          const checkpointDir = config?.getProjectTempDir()
            ? path.join(config.getProjectTempDir(), 'checkpoints')
            : undefined;

          if (!checkpointDir) {
            addMessage({
              type: MessageType.ERROR,
              content: 'Could not determine the .gemini directory path.',
              timestamp: new Date(),
            });
            return;
          }

          try {
            // Ensure the directory exists before trying to read it.
            await fs.mkdir(checkpointDir, { recursive: true });
            const files = await fs.readdir(checkpointDir);
            const jsonFiles = files.filter((file) => file.endsWith('.json'));

            if (!subCommand) {
              if (jsonFiles.length === 0) {
                addMessage({
                  type: MessageType.INFO,
                  content: 'No restorable tool calls found.',
                  timestamp: new Date(),
                });
                return;
              }
              const truncatedFiles = jsonFiles.map((file) => {
                const components = file.split('.');
                if (components.length <= 1) {
                  return file;
                }
                components.pop();
                return components.join('.');
              });
              const fileList = truncatedFiles.join('\n');
              addMessage({
                type: MessageType.INFO,
                content: `Available tool calls to restore:\n\n${fileList}`,
                timestamp: new Date(),
              });
              return;
            }

            const selectedFile = subCommand.endsWith('.json')
              ? subCommand
              : `${subCommand}.json`;

            if (!jsonFiles.includes(selectedFile)) {
              addMessage({
                type: MessageType.ERROR,
                content: `File not found: ${selectedFile}`,
                timestamp: new Date(),
              });
              return;
            }

            const filePath = path.join(checkpointDir, selectedFile);
            const data = await fs.readFile(filePath, 'utf-8');
            const toolCallData = JSON.parse(data);

            if (toolCallData.history) {
              loadHistory(toolCallData.history);
            }

            if (toolCallData.clientHistory) {
              await config
                ?.getGeminiClient()
                ?.setHistory(toolCallData.clientHistory);
            }

            if (toolCallData.commitHash) {
              await gitService?.restoreProjectFromSnapshot(
                toolCallData.commitHash,
              );
              addMessage({
                type: MessageType.INFO,
                content: `Restored project to the state before the tool call.`,
                timestamp: new Date(),
              });
            }

            return {
              shouldScheduleTool: true,
              toolName: toolCallData.toolCall.name,
              toolArgs: toolCallData.toolCall.args,
            };
          } catch (error) {
            addMessage({
              type: MessageType.ERROR,
              content: `Could not read restorable tool calls. This is the error: ${error}`,
              timestamp: new Date(),
            });
          }
        },
      });
    }
    return commands;
  }, [
    onDebugMessage,
    setShowHelp,
    refreshStatic,
    openThemeDialog,
    openAuthDialog,
    openEditorDialog,
    clearItems,
    performMemoryRefresh,
    showMemoryAction,
    addMemoryAction,
    addMessage,
    toggleCorgiMode,
    savedChatTags,
    config,
    settings,
    showToolDescriptions,
    session,
    gitService,
    loadHistory,
    addItem,
    setQuittingMessages,
    pendingCompressionItemRef,
    setPendingCompressionItem,
    openPrivacyNotice,
  ]);

  const handleSlashCommand = useCallback(
    async (
      rawQuery: PartListUnion,
    ): Promise<SlashCommandActionReturn | boolean> => {
      if (typeof rawQuery !== 'string') {
        return false;
      }
      const trimmed = rawQuery.trim();
      if (!trimmed.startsWith('/') && !trimmed.startsWith('?')) {
        return false;
      }
      const userMessageTimestamp = Date.now();
      if (trimmed !== '/quit' && trimmed !== '/exit') {
        addItem(
          { type: MessageType.USER, text: trimmed },
          userMessageTimestamp,
        );
      }

      let subCommand: string | undefined;
      let args: string | undefined;

      const commandToMatch = (() => {
        if (trimmed.startsWith('?')) {
          return 'help';
        }
        const parts = trimmed.substring(1).trim().split(/\s+/);
        if (parts.length > 1) {
          subCommand = parts[1];
        }
        if (parts.length > 2) {
          args = parts.slice(2).join(' ');
        }
        return parts[0];
      })();

      const mainCommand = commandToMatch;

      for (const cmd of slashCommands) {
        if (mainCommand === cmd.name || mainCommand === cmd.altName) {
          const actionResult = await cmd.action(mainCommand, subCommand, args);
          if (
            typeof actionResult === 'object' &&
            actionResult?.shouldScheduleTool
          ) {
            return actionResult; // Return the object for useGeminiStream
          }
          return true; // Command was handled, but no tool to schedule
        }
      }

      addMessage({
        type: MessageType.ERROR,
        content: `Unknown command: ${trimmed}`,
        timestamp: new Date(),
      });
      return true; // Indicate command was processed (even if unknown)
    },
    [addItem, slashCommands, addMessage],
  );

  return { handleSlashCommand, slashCommands, pendingHistoryItems };
};
