# Agent Note: TaskFlow projects open independently of closure debts

Status: implemented

English | [中文](2026-10-07-taskflow-project-access.zh.md)

## Problem

A start-only task occupies the current-task row rather than the ended timeline. The empty timeline said there were no attention events even when the current task was visible. Project trees were reachable only through project names in the needs-you tray, leaving projects without closure debts inaccessible.

## Decision

The empty timeline names either the recorded current task or the absence of ended periods. A native 项目 selector in the expanded header opens the existing tree independently of the tray. Its options combine the tree’s 7-day activity window, unresolved and parked debts of any age, saved mainline picks, and open todos from mapped bus files; project aliases collapse to one option. Todo files load on startup and project changes, with failures visible in the header or tree and stale responses discarded.

## Alternatives considered

Relying on the tray retains the missing entry for debt-free projects. Adding unfinished tasks to history would change the distinction between current work and ended periods just to repair an empty-state label.

## Consequences

Current-only and todo-only projects have a direct entry. Ledger folding, the 30-minute silence rule, and exact human-confirmed closure remain unchanged. A new todo-only project added while the page stays open appears after a reload or project change; todo discovery does not add another polling loop.
