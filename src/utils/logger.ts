/**
 * Structured logging utility
 * Provides consistent logging across the application with context
 */

import { appConfig } from '../config';

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
}

interface LogContext {
  requestId?: string;
  userId?: string;
  action?: string;
  [key: string]: unknown;
}

class Logger {
  private context: LogContext = {};

  /**
   * Set context that will be included in all subsequent logs
   */
  setContext(context: LogContext): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * Clear the current context
   */
  clearContext(): void {
    this.context = {};
  }

  /**
   * Log an error message
   */
  error(message: string, error?: Error | unknown, meta?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, { error: this.serializeError(error), ...meta });
  }

  /**
   * Log a warning message
   */
  warn(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, meta);
  }

  /**
   * Log an info message
   */
  info(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, meta);
  }

  /**
   * Log a debug message
   */
  debug(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, meta);
  }

  /**
   * Core logging function
   */
  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.context,
      ...meta,
      environment: appConfig.environment,
    };

    // In production, use JSON format for CloudWatch parsing
    if (appConfig.environment === 'production') {
      console.log(JSON.stringify(logEntry));
    } else {
      // In development, use human-readable format
      const contextStr = Object.keys(this.context).length > 0
        ? ` [${JSON.stringify(this.context)}]`
        : '';
      const metaStr = meta && Object.keys(meta).length > 0
        ? ` ${JSON.stringify(meta)}`
        : '';
      console.log(`[${level.toUpperCase()}] ${message}${contextStr}${metaStr}`);
    }
  }

  /**
   * Determine if a message at this level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.ERROR, LogLevel.WARN, LogLevel.INFO, LogLevel.DEBUG];
    const currentLevelIndex = levels.indexOf(appConfig.logLevel as LogLevel);
    const messageLevelIndex = levels.indexOf(level);

    return messageLevelIndex <= currentLevelIndex;
  }

  /**
   * Serialize error objects for logging
   */
  private serializeError(error: Error | unknown): Record<string, unknown> | undefined {
    if (!error) return undefined;

    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: appConfig.enableDetailedErrors ? error.stack : undefined,
      };
    }

    return { error: String(error) };
  }
}

// Export singleton instance
export const logger = new Logger();
