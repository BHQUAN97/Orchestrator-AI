#!/usr/bin/env node
/**
 * @fileoverview Configuration manager for OrcAI CLI
 * @module lib/config
 * @description Quan ly config: load/save/get/set voi dot-notation, auto-detect .env
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Default configuration */
const DEFAULTS = {
  litellm: { url: 'http://localhost:5002', key: '' },
  model: 'smart',
  role: 'builder',
  maxIterations: 30,
  confirm: true,
  theme: 'default',
};

class Config {
  /**
   * @param {Object|string} [options] - Config path string hoặc options object { configPath }
   */
  constructor(options = {}) {
    const configPath = typeof options === 'string' ? options : options.configPath;
    this.configPath = configPath || path.join(os.homedir(), '.orcai', 'config.json');
    this._config = null;
  }

  /**
   * Load config from file, merge with defaults and .env overrides
   * @returns {object} Merged config
   */
  load() {
    // Start with defaults
    let fileConfig = {};

    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        fileConfig = JSON.parse(raw);
      }
    } catch (err) {
      // File khong doc duoc → dung defaults
    }

    // Deep merge defaults + file config
    this._config = this._deepMerge(DEFAULTS, fileConfig);

    // Auto-detect .env in CWD
    this._loadEnvOverrides();

    return this._config;
  }

  /**
   * Save config to file
   * @param {object} [config] - Config to save. If omitted, saves current config
   */
  save(config) {
    if (config) {
      this._config = config;
    }
    if (!this._config) {
      this._config = { ...DEFAULTS };
    }

    // Tao directory neu chua co
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.configPath, JSON.stringify(this._config, null, 2), 'utf-8');
  }

  /**
   * Get value by dot-notation key
   * @param {string} key - e.g. 'litellm.url', 'model'
   * @returns {*} Value or undefined
   */
  get(key) {
    if (!this._config) this.load();

    const parts = key.split('.');
    let current = this._config;

    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = current[part];
    }

    return current;
  }

  /**
   * Set value by dot-notation key and save
   * @param {string} key - e.g. 'litellm.key', 'maxIterations'
   * @param {*} value - Value to set
   */
  set(key, value) {
    if (!this._config) this.load();

    const parts = key.split('.');
    let current = this._config;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (current[part] == null || typeof current[part] !== 'object') {
        current[part] = {};
      }
      current = current[part];
    }

    current[parts[parts.length - 1]] = value;
    this.save();
  }

  /**
   * Auto-detect LITELLM_URL / LITELLM_KEY tu .env trong CWD
   * @private
   */
  _loadEnvOverrides() {
    const envPath = path.join(process.cwd(), '.env');

    try {
      if (!fs.existsSync(envPath)) return;

      const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;

        const key = trimmed.substring(0, eqIndex).trim();
        // Bo quotes neu co
        let val = trimmed.substring(eqIndex + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }

        if (key === 'LITELLM_URL' && val) {
          this._config.litellm.url = val;
        } else if (key === 'LITELLM_KEY' && val) {
          this._config.litellm.key = val;
        }
      }
    } catch (err) {
      // .env khong doc duoc → bo qua
    }
  }

  /**
   * Deep merge two objects (source overrides target)
   * @private
   */
  _deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (
        source[key] &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        target[key] &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        result[key] = this._deepMerge(target[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }
}

module.exports = { Config, DEFAULTS };
