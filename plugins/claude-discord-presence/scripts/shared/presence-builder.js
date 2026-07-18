'use strict';

function truncate(value, maximumLength) {
  return String(value ?? '').slice(0, maximumLength);
}

function buildPresence(options) {
  const {
    details,
    state,
    startedAt,
    showElapsedTime = true,
    repositoryUrl,
    repositoryButtonLabel = 'View Repository'
  } = options;

  return {
    details: truncate(details, 128),
    state: truncate(state, 128),
    ...(showElapsedTime ? { timestamps: { start: startedAt } } : {}),
    instance: false,
    buttons: repositoryUrl
      ? [{ label: truncate(repositoryButtonLabel, 32), url: repositoryUrl }]
      : undefined
  };
}

module.exports = { buildPresence, truncate };
