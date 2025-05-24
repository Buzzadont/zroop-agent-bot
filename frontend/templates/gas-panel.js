/**
 * Gas panel component for showing current gas prices in the WebApp
 * This can be included in the main interface.html file
 */

class GasPanel {
  constructor(containerId, apiUrl) {
    this.container = document.getElementById(containerId);
    this.apiUrl = apiUrl || window.location.origin;
    this.gasData = null;
    this.autoRefreshInterval = null;
    this.refreshTimeoutId = null;
    this.isLoading = false;
    
    // Create UI elements
    this.createUI();
  }
  
  createUI() {
    if (!this.container) {
      console.error('Container element not found');
      return;
    }
    
    // Create panel structure
    this.container.innerHTML = `
      <div class="gas-panel">
        <div class="gas-panel-header">
          <h3>Gas Prices <span class="gas-refresh-status"></span></h3>
          <button class="gas-refresh-btn button">↻</button>
        </div>
        <div class="gas-panel-body">
          <div class="gas-loading">Loading gas prices...</div>
          <div class="gas-error" style="display: none;"></div>
          <div class="gas-content" style="display: none;">
            <div class="gas-current">
              <div class="gas-label">Current:</div>
              <div class="gas-value">-- Gwei</div>
              <div class="gas-tia">-- TIA</div>
            </div>
            <div class="gas-options">
              <div class="gas-option gas-slow">
                <div class="option-label">Slow</div>
                <div class="option-price">-- Gwei</div>
                <div class="option-time">~60s</div>
              </div>
              <div class="gas-option gas-standard">
                <div class="option-label">Standard</div>
                <div class="option-price">-- Gwei</div>
                <div class="option-time">~30s</div>
              </div>
              <div class="gas-option gas-fast">
                <div class="option-label">Fast</div>
                <div class="option-price">-- Gwei</div>
                <div class="option-time">~15s</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    
    // Add styles
    const style = document.createElement('style');
    style.textContent = `
      .gas-panel {
        background-color: #1e2a38;
        border: 1px solid #00ff00;
        border-radius: 5px;
        margin: 10px 0;
        overflow: hidden;
      }
      .gas-panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        background-color: #1a2130;
      }
      .gas-panel-header h3 {
        margin: 0;
        font-size: 14px;
        color: #00ff00;
      }
      .gas-refresh-status {
        font-size: 12px;
        color: #888;
        margin-left: 8px;
      }
      .gas-refresh-btn {
        background: none;
        border: none;
        color: #00ff00;
        cursor: pointer;
        font-size: 16px;
        padding: 0 5px;
      }
      .gas-refresh-btn:hover {
        color: #00cc00;
      }
      .gas-panel-body {
        padding: 12px;
      }
      .gas-loading {
        text-align: center;
        color: #aaa;
        font-size: 13px;
      }
      .gas-error {
        color: #ff5555;
        text-align: center;
        padding: 10px;
        font-size: 13px;
      }
      .gas-current {
        display: flex;
        align-items: center;
        margin-bottom: 12px;
        border-bottom: 1px dotted #333;
        padding-bottom: 10px;
      }
      .gas-label {
        color: #aaa;
        width: 70px;
      }
      .gas-value {
        flex: 1;
        font-weight: bold;
        color: #00ff00;
      }
      .gas-tia {
        color: #aaa;
        font-size: 12px;
      }
      .gas-options {
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      .gas-option {
        flex: 1;
        text-align: center;
        padding: 8px;
        border-radius: 4px;
        background-color: #15212f;
      }
      .gas-slow {
        border-left: 3px solid #88aa00;
      }
      .gas-standard {
        border-left: 3px solid #00aa00;
      }
      .gas-fast {
        border-left: 3px solid #00cc88;
      }
      .option-label {
        color: #aaa;
        font-size: 12px;
        margin-bottom: 4px;
      }
      .option-price {
        font-weight: bold;
        color: #00ff00;
      }
      .option-time {
        font-size: 11px;
        color: #888;
        margin-top: 4px;
      }
    `;
    document.head.appendChild(style);
    
    // Add event listeners
    const refreshBtn = this.container.querySelector('.gas-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.fetchGasPrice());
    }
    
    // Initial data fetch
    this.fetchGasPrice();
    
    // Setup auto-refresh (every 30 seconds)
    this.startAutoRefresh();
  }
  
  startAutoRefresh(interval = 30000) {
    this.stopAutoRefresh(); // Clear any existing interval
    this.autoRefreshInterval = setInterval(() => {
      this.fetchGasPrice();
    }, interval);
  }
  
  stopAutoRefresh() {
    if (this.autoRefreshInterval) {
      clearInterval(this.autoRefreshInterval);
      this.autoRefreshInterval = null;
    }
  }
  
  updateRefreshStatus() {
    const statusEl = this.container.querySelector('.gas-refresh-status');
    if (statusEl) {
      statusEl.textContent = `(updated ${this.getTimeAgo(this.lastUpdated)})`;
    }
    
    // Schedule next update of time ago text
    if (this.refreshTimeoutId) {
      clearTimeout(this.refreshTimeoutId);
    }
    
    this.refreshTimeoutId = setTimeout(() => {
      this.updateRefreshStatus();
    }, 10000); // Update the "time ago" text every 10 seconds
  }
  
  getTimeAgo(timestamp) {
    if (!timestamp) return '';
    
    const now = new Date();
    const diff = Math.floor((now - timestamp) / 1000); // seconds ago
    
    if (diff < 10) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    
    const mins = Math.floor(diff / 60);
    if (mins === 1) return '1 min ago';
    return `${mins} mins ago`;
  }
  
  async fetchGasPrice() {
    if (this.isLoading) return;
    
    try {
      this.isLoading = true;
      this.showLoading(true);
      this.showError('');
      
      const response = await fetch(`${this.apiUrl}/api/v1/gas/price`);
      if (!response.ok) {
        throw new Error('Failed to fetch gas price data');
      }
      
      const data = await response.json();
      
      if (!data.success || !data.gasPrice) {
        throw new Error('Invalid gas price data received');
      }
      
      this.gasData = data.gasPrice;
      this.lastUpdated = new Date();
      this.updateRefreshStatus();
      this.updateUI();
      
    } catch (error) {
      console.error('Error fetching gas price:', error);
      this.showError(error.message || 'Failed to load gas price data');
    } finally {
      this.isLoading = false;
      this.showLoading(false);
    }
  }
  
  showLoading(show) {
    const loadingEl = this.container.querySelector('.gas-loading');
    const contentEl = this.container.querySelector('.gas-content');
    
    if (loadingEl) {
      loadingEl.style.display = show ? 'block' : 'none';
    }
    
    if (contentEl && this.gasData) {
      contentEl.style.display = show ? 'none' : 'block';
    }
  }
  
  showError(message) {
    const errorEl = this.container.querySelector('.gas-error');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = message ? 'block' : 'none';
    }
  }
  
  updateUI() {
    if (!this.gasData) return;
    
    // Update current gas price
    const valueEl = this.container.querySelector('.gas-value');
    const tiaEl = this.container.querySelector('.gas-tia');
    
    if (valueEl) {
      valueEl.textContent = `${this.gasData.formatted.gwei} Gwei`;
    }
    
    if (tiaEl) {
      tiaEl.textContent = `${this.gasData.formatted.tia} TIA`;
    }
    
    // Update gas options
    const slowEl = this.container.querySelector('.gas-slow .option-price');
    const standardEl = this.container.querySelector('.gas-standard .option-price');
    const fastEl = this.container.querySelector('.gas-fast .option-price');
    
    // Helper to format wei to gwei
    const toGwei = (wei) => {
      return (Number(wei) / 1e9).toFixed(2);
    };
    
    if (slowEl && this.gasData.slow) {
      slowEl.textContent = `${toGwei(this.gasData.slow)} Gwei`;
    }
    
    if (standardEl) {
      standardEl.textContent = `${this.gasData.formatted.gwei} Gwei`;
    }
    
    if (fastEl && this.gasData.fast) {
      fastEl.textContent = `${toGwei(this.gasData.fast)} Gwei`;
    }
    
    // Show the content
    const contentEl = this.container.querySelector('.gas-content');
    if (contentEl) {
      contentEl.style.display = 'block';
    }
  }
  
  // Clean up resources when component is destroyed
  destroy() {
    this.stopAutoRefresh();
    if (this.refreshTimeoutId) {
      clearTimeout(this.refreshTimeoutId);
    }
  }
}

// Example usage:
// const gasPanel = new GasPanel('gas-container', 'https://your-api-url.com'); 