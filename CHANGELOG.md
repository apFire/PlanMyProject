# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- Optimized activation and startup overhead with lazy loading and narrower activation/watch scopes.
- Added in-tree progress reporting for Copilot requests and moved status to the active task item.
- Added cancellable active-request flow with `PlanMyProject: Cancel Active Request`.
- Added command icon for cancel action and conditional tree menu behavior for running tasks.
- Hardened generated workspace writes against symlink-escape paths outside workspace root.
- Expanded tests to cover tree-provider runtime behavior.

## [0.1.1] - 2026-02-23

- Added `Allow All` option in Copilot consent modal for session-scoped approval.
- Expanded README with explicit data exchange details for Copilot requests.
- Documented supported workspace edit behavior and sensitive-file safeguards.

## [0.1.0] - 2026-02-22

- First publish-ready release of PlanMyProject.
- Added extension metadata and Marketplace publishing scripts.
- Added packaging hygiene updates and license.
