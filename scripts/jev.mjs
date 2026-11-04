#!/usr/bin/env node
// Compatibilidade de CLI: a skill passou a som-agent-skill; o runtime Jev continua disponível.
// Mantém os comandos existentes sem copiar lógica nem criar outro processo.
import "./som.mjs";
