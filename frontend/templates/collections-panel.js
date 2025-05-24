/**
 * Collections panel component for showing NFT collections and user's NFTs in the WebApp
 * This can be included in the main interface.html file
 */

class CollectionsPanel {
  constructor(containerId, apiUrl, walletAddress) {
    this.container = document.getElementById(containerId);
    this.apiUrl = apiUrl || window.location.origin;
    this.walletAddress = walletAddress;
    this.collections = [];
    this.userNfts = [];
    this.isLoading = false;
    this.currentView = 'collections'; // 'collections' or 'user-nfts'
    this.currentPage = 1;
    this.pageSize = 6;
    this.totalPages = 1;
    this.totalItems = 0; // Add totalItems to store the count from the server
    
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
      <div class="collections-panel">
        <div class="collections-panel-header">
          <h3>NFT Explorer</h3>
          <div class="collections-tabs">
            <button class="collections-tab active" data-view="collections">Collections</button>
            <button class="collections-tab" data-view="user-nfts">Your NFTs</button>
          </div>
        </div>
        <div class="collections-panel-body">
          <div class="collections-loading">Loading collections...</div>
          <div class="collections-error" style="display: none;"></div>
          <div class="collections-content" style="display: none;">
            <div class="collections-grid"></div>
            <div class="collections-pagination">
              <button class="pagination-prev button" disabled>&lt; Prev</button>
              <span class="pagination-info">Page 1 of 1</span>
              <button class="pagination-next button" disabled>Next &gt;</button>
            </div>
          </div>
        </div>
      </div>
    `;
    
    // Add styles
    const style = document.createElement('style');
    style.textContent = `
      .collections-panel {
        background-color: #1e2a38;
        border: 1px solid #00ff00;
        border-radius: 5px;
        margin: 10px 0;
        overflow: hidden;
      }
      .collections-panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        background-color: #1a2130;
      }
      .collections-panel-header h3 {
        margin: 0;
        font-size: 14px;
        color: #00ff00;
      }
      .collections-tabs {
        display: flex;
      }
      .collections-tab {
        background: none;
        border: none;
        color: #aaa;
        cursor: pointer;
        padding: 5px 10px;
        font-size: 12px;
        border-bottom: 2px solid transparent;
      }
      .collections-tab.active {
        color: #00ff00;
        border-bottom: 2px solid #00ff00;
      }
      .collections-panel-body {
        padding: 12px;
      }
      .collections-loading {
        text-align: center;
        color: #aaa;
        font-size: 13px;
        padding: 20px 0;
      }
      .collections-error {
        color: #ff5555;
        text-align: center;
        padding: 10px;
        font-size: 13px;
      }
      .collections-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 12px;
        margin-bottom: 15px;
      }
      .collection-card {
        background-color: #1a2130;
        border-radius: 5px;
        overflow: hidden;
        transition: transform 0.2s;
        cursor: pointer;
      }
      .collection-card:hover {
        transform: translateY(-3px);
      }
      .collection-image {
        width: 100%;
        height: 120px;
        background-color: #0d1520;
        background-size: cover;
        background-position: center;
      }
      .collection-info {
        padding: 8px;
      }
      .collection-name {
        font-size: 12px;
        font-weight: bold;
        color: #00ff00;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .collection-details {
        display: flex;
        justify-content: space-between;
        margin-top: 5px;
        font-size: 10px;
        color: #aaa;
      }
      .collections-pagination {
        display: flex;
        justify-content: center;
        align-items: center;
        margin-top: 15px;
      }
      .pagination-info {
        margin: 0 10px;
        font-size: 12px;
        color: #aaa;
      }
      .pagination-prev, .pagination-next {
        font-size: 12px;
        padding: 4px 8px;
      }
      .nft-badge {
        position: absolute;
        top: 5px;
        right: 5px;
        background-color: rgba(0, 255, 0, 0.7);
        color: #000;
        font-size: 10px;
        padding: 2px 5px;
        border-radius: 3px;
      }
    `;
    document.head.appendChild(style);
    
    // Add event listeners
    this.container.querySelectorAll('.collections-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const view = tab.dataset.view;
        this.switchView(view);
      });
    });
    
    const prevBtn = this.container.querySelector('.pagination-prev');
    const nextBtn = this.container.querySelector('.pagination-next');
    
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (this.currentPage > 1) {
          this.currentPage--;
          this.renderCurrentView();
        }
      });
    }
    
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (this.currentPage < this.totalPages) {
          this.currentPage++;
          this.renderCurrentView();
        }
      });
    }
    
    // Initial data fetch
    this.fetchCollections();
  }
  
  switchView(view) {
    this.currentView = view;
    this.currentPage = 1;
    
    // Update active tab
    this.container.querySelectorAll('.collections-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.view === view);
    });
    
    // Load data based on current view
    if (view === 'collections') {
      this.fetchCollections();
    } else if (view === 'user-nfts') {
      if (this.walletAddress) {
        this.fetchUserNfts();
      } else {
        this.showError('No wallet connected. Please connect your wallet first.');
      }
    }
  }
  
  async fetchCollections() {
    if (this.isLoading) return;
    
    try {
      this.isLoading = true;
      this.showLoading(true);
      this.showError('');
      
      // Construct the URL with page and limit parameters
      const url = `${this.apiUrl}/api/v1/collections/all?page=${this.currentPage}&limit=${this.pageSize}`;
      //console.log(`[CollectionsPanel] Fetching collections from: ${url}`); // For debugging

      const response = await fetch(url);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Failed to fetch collections and parse error response' }));
        throw new Error(errorData.message || 'Failed to fetch collections');
      }
      
      const data = await response.json();
      
      if (!data.items || typeof data.totalItems !== 'number' || typeof data.totalPages !== 'number') {
        console.error('[CollectionsPanel] Invalid collections data received:', data);
        throw new Error('Invalid collections data structure received');
      }
      
      this.collections = data.items;
      this.totalItems = data.totalItems;
      this.totalPages = data.totalPages;
      this.currentPage = data.currentPage; // Ensure currentPage is also updated from response

      this.renderCollections(); // Render the fetched collections
      this.updatePagination();  // Update pagination controls based on new data
      
    } catch (error) {
      console.error('[CollectionsPanel] Error fetching collections:', error);
      this.showError(error.message || 'Could not load collections.');
      // Optionally clear existing collections or show them as stale
      this.collections = [];
      this.totalItems = 0;
      this.totalPages = 1;
      this.renderCollections(); // Render empty or stale state
      this.updatePagination();
    } finally {
      this.isLoading = false;
      this.showLoading(false);
    }
  }
  
  async fetchUserNfts() {
    if (this.isLoading || !this.walletAddress) return;
    
    try {
      this.isLoading = true;
      this.showLoading(true);
      this.showError('');
      
      const response = await fetch(`${this.apiUrl}/api/v1/nfts/user/${this.walletAddress}`);
      if (!response.ok) {
        throw new Error('Failed to fetch your NFTs');
      }
      
      const data = await response.json();
      
      if (!data.items) {
        throw new Error('Invalid NFT data received');
      }
      
      this.userNfts = data.items;
      this.totalPages = Math.ceil(this.userNfts.length / this.pageSize);
      this.renderUserNfts();
      
    } catch (error) {
      console.error('Error fetching user NFTs:', error);
      this.showError(error.message || 'Failed to load your NFTs');
    } finally {
      this.isLoading = false;
      this.showLoading(false);
    }
  }
  
  renderCurrentView() {
    if (this.currentView === 'collections') {
      this.renderCollections();
    } else if (this.currentView === 'user-nfts') {
      this.renderUserNfts();
    }
    this.updatePagination(); // Update pagination after rendering view
  }
  
  renderCollections() {
    const gridEl = this.container.querySelector('.collections-grid');
    if (!gridEl) return;
    
    // Calculate pagination
    const start = (this.currentPage - 1) * this.pageSize;
    const end = start + this.pageSize;
    const pageItems = this.collections.slice(start, end);
    
    let html = '';
    
    if (pageItems.length === 0) {
      html = '<div class="collections-empty">No collections found</div>';
    } else {
      pageItems.forEach(collection => {
        const imageUrl = collection.imageUrl || 'https://via.placeholder.com/150?text=No+Image';
        
        html += `
          <div class="collection-card" data-id="${collection.id}">
            <div class="collection-image" style="background-image: url('${imageUrl}')"></div>
            <div class="collection-info">
              <div class="collection-name">${collection.name}</div>
              <div class="collection-details">
                <span>Items: ${collection.itemCount || '?'}</span>
                <span>${collection.floorPrice ? collection.floorPrice + ' TIA' : 'No floor'}</span>
              </div>
            </div>
          </div>
        `;
      });
    }
    
    gridEl.innerHTML = html;
    
    // Add event listeners to collection cards
    gridEl.querySelectorAll('.collection-card').forEach(card => {
      card.addEventListener('click', () => {
        const collectionId = card.dataset.id;
        this.showCollectionDetails(collectionId);
      });
    });
    
    // Update pagination
    this.updatePagination();
  }
  
  renderUserNfts() {
    const gridEl = this.container.querySelector('.collections-grid');
    if (!gridEl) return;
    
    // Calculate pagination
    const start = (this.currentPage - 1) * this.pageSize;
    const end = start + this.pageSize;
    const pageItems = this.userNfts.slice(start, end);
    
    let html = '';
    
    if (pageItems.length === 0) {
      html = '<div class="collections-empty">No NFTs found in your wallet</div>';
    } else {
      pageItems.forEach(nft => {
        const imageUrl = nft.imageUrl || 'https://via.placeholder.com/150?text=No+Image';
        
        html += `
          <div class="collection-card" data-id="${nft.id}" data-token-id="${nft.tokenId}">
            <div class="collection-image" style="background-image: url('${imageUrl}')"></div>
            <div class="collection-info">
              <div class="collection-name">${nft.name}</div>
              <div class="collection-details">
                <span>${nft.collectionName}</span>
                ${nft.floorPrice ? `<span>${nft.floorPrice} TIA</span>` : ''}
              </div>
            </div>
          </div>
        `;
      });
    }
    
    gridEl.innerHTML = html;
    
    // Add event listeners to NFT cards
    gridEl.querySelectorAll('.collection-card').forEach(card => {
      card.addEventListener('click', () => {
        const nftId = card.dataset.id;
        const tokenId = card.dataset.tokenId;
        this.showNftDetails(nftId, tokenId);
      });
    });
    
    // Update pagination
    this.updatePagination();
  }
  
  updatePagination() {
    const paginationInfo = this.container.querySelector('.pagination-info');
    const prevBtn = this.container.querySelector('.pagination-prev');
    const nextBtn = this.container.querySelector('.pagination-next');
    
    if (paginationInfo) {
      paginationInfo.textContent = `Page ${this.currentPage} of ${this.totalPages} (Total: ${this.totalItems})`;
    }
    
    if (prevBtn) {
      prevBtn.disabled = this.currentPage <= 1;
    }
    
    if (nextBtn) {
      nextBtn.disabled = this.currentPage >= this.totalPages;
    }
  }
  
  showLoading(show) {
    const loadingEl = this.container.querySelector('.collections-loading');
    const contentEl = this.container.querySelector('.collections-content');
    
    if (loadingEl) {
      loadingEl.style.display = show ? 'block' : 'none';
    }
    
    if (contentEl) {
      contentEl.style.display = show ? 'none' : 'block';
    }
  }
  
  showError(message) {
    const errorEl = this.container.querySelector('.collections-error');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = message ? 'block' : 'none';
    }
  }
  
  showCollectionDetails(collectionId) {
    // console.log(`Showing details for collection: ${collectionId}`);
    // This would open a modal or navigate to a collection details page
    // For now, we'll just log the action
  }
  
  showNftDetails(nftId, tokenId) {
    // console.log(`Showing details for NFT: ${nftId}, Token ID: ${tokenId}`);
    // This would open a modal or navigate to an NFT details page
    // For now, we'll just log the action
  }
  
  // Update wallet address and refresh user NFTs if in user-nfts view
  setWalletAddress(address) {
    this.walletAddress = address;
    if (this.currentView === 'user-nfts' && address) {
      this.fetchUserNfts();
    }
  }
  
  // Clean up resources when component is destroyed
  destroy() {
    // Nothing to clean up for now
  }
}

// Example usage:
// const collectionsPanel = new CollectionsPanel('collections-container', 'https://your-api-url.com'); 
// If user connects wallet later: collectionsPanel.setWalletAddress('0x123...'); 