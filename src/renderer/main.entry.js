/* WA Deck renderer entry point.
   Side-effect imports mirror the old index.html <script> tag order; the
   bootstrap sequence itself lives in core/init.js (imported last). */
import './templates.js';
import './webview-scripts/keep-alive.js';
import './webview-scripts/bridge.js';
import './webview-scripts/collect-chats.js';
import './webview-scripts/unread-count.js';
import './webview-scripts/collect-unread-chats.js';
import './webview-scripts/active-chat-contact.js';
import './webview-scripts/crm-hover-bridge.js';
import './webview-scripts/insert-text.js';
import './webview-scripts/voice-message.js';
import './webview-scripts/translator-bar.js';
import './weather.js';
import './auto-update.js';
import './unread.js';
import './crm.js';
import './favorites.js';
import './important.js';
import './notifications.js';
import './global-search.js';
import './pin-feed.js';
import './unread-feed.js';
import './help.js';
import './schedule.js';
import './split.js';
import './signal-panel.js';
import './core/init.js';
