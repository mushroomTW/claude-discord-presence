# Privacy Policy

Last updated: July 18, 2026

## Overview

Claude Discord Presence is designed to display Claude Desktop activity in Discord through local Discord Rich Presence communication.

## Information Processed Locally

The Plugin may read the following information locally to prepare a Rich Presence status:

- The current workspace or project name.
- Local Git repository metadata, such as a repository URL, when the repository button is enabled.
- When `showConversationTitle` is enabled, the local Claude transcript is read line by line to locate `custom-title` records. Other records are not used for the Presence status.
- Plugin configuration and process state, including a process ID and diagnostic log.

This information is processed on your device by the Plugin.

## Information Shared with Discord

When Discord Rich Presence is active, the Plugin sends the configured status details, state, timestamps, and optional button metadata to the Discord desktop client over its local IPC connection. If conversation-title display is enabled, the selected title becomes the status state. Discord then handles that presence according to its own policies and settings.

Do not enable project names or repository buttons if they could reveal confidential information.

## Data Collection and Storage

The Plugin does not operate a remote service, collect analytics, create user accounts, or transmit data to the Plugin authors. By default, local process state, session metadata, diagnostics, and logs are stored under `%LOCALAPPDATA%\\claude-discord-presence`; shared Broker state is stored under `%LOCALAPPDATA%\\discord-presence-broker`. `CLAUDE_PRESENCE_DATA` can override the first location. These files can contain local workspace and transcript paths. Uninstalling the Plugin does not currently remove these directories; delete them manually if you want to erase retained local data.

## Third-Party Services

Your use of Claude and Discord is governed by their respective privacy policies. The Plugin cannot control how those services process information once it is provided to them.

## Changes to This Policy

This policy may be updated by publishing a revised version in this repository. Continued use of the Plugin after an update constitutes acceptance of the revised policy.

## Contact

For privacy questions, open an issue in the Plugin repository.
