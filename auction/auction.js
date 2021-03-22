require('log-timestamp');
const kava = require('@kava-labs/javascript-sdk');
const cron = require('node-cron');
const prices = require('./prices');
const utils = require('./utils');

const VALID_AUCTION_TYPES = ['collateral'];
class AuctionBot {
  constructor(
    lcdUrl,
    mnemonic,
    auctionTypes,
    ignoredAddresses,
    collaterals,
    initialBidForward,
    forwardBidMax,
    forwardBidMargin,
    reverseBidMargin,
    crontab
  ) {
    if (!lcdUrl) {
      throw new Error('must specify rest-server lcd-url');
    }
    if (!mnemonic) {
      throw new Error('must specify mnemonic');
    }
    if (!crontab) {
      throw new Error('must specify crontab');
    }
    if (!auctionTypes) {
      throw new Error('must specify at least one auction type');
    }
    this.auctionTypes = auctionTypes.split(',').map((x) => x.toLowerCase());
    if (
      !this.auctionTypes.some((auctionType) =>
        VALID_AUCTION_TYPES.includes(auctionType)
      )
    ) {
      throw new Error('must specify at least one valid auction type');
    }
    if (this.auctionTypes.includes('collateral')) {
      console.log('this bot will bid on collateral auctions');
      if (!collaterals) {
        throw new Error('must specify at least one collateral type to bid on');
      }
      if (!initialBidForward) {
        throw new Error('must specify initial forward bid percentage');
      }
      const initialBidForwardFloat = Number.parseFloat(initialBidForward);
      if (initialBidForwardFloat < 0 || initialBidForwardFloat > 1.0) {
        throw new Error('forward initial bid must be between 0 and 1');
      }
      if (!forwardBidMax) {
        throw new Error('must specify forward bid maximum');
      }
      const forwardBidMaxFloat = Number.parseFloat(forwardBidMax);
      if (forwardBidMaxFloat < 0 || forwardBidMaxFloat > 1.0) {
        throw new Error('forward bid maximum must be between 0 and 1');
      }
      if (!forwardBidMargin) {
        throw new Error('must specify forward bid margin');
      }
      const forwardBidMarginFloat = Number.parseFloat(forwardBidMargin);
      if (forwardBidMarginFloat < 0 || forwardBidMarginFloat > 1.0) {
        throw new Error('forward bid margin must be between 0 and 1');
      }
      if (!reverseBidMargin) {
        throw new Error('must specify reverse bid margin');
      }
      const reverseBidMarginFloat = Number.parseFloat(reverseBidMargin);
      if (reverseBidMarginFloat < 0 || reverseBidMarginFloat > 1.0) {
        throw new Error('reverse bid margin must be between 0 and 1');
      }
    }

    this.lcdURL = lcdUrl;
    this.mnemonic = mnemonic;
    this.ignoredAddresses = ignoredAddresses ? ignoredAddresses.split(',') : [];
    this.collaterals = collaterals ? collaterals.split(',') : [];
    this.initialBidForward = Number.parseFloat(initialBidForward);
    this.forwardBidMax = Number.parseFloat(forwardBidMax);
    this.forwardBidMargin = Number.parseFloat(forwardBidMargin);
    this.reverseBidMargin = Number.parseFloat(reverseBidMargin);
    this.crontab = crontab;
  }

  /**
   * Initialize the Kava client
   * @param {String} lcdURL api endpoint for Kava's rest-server
   * @param {String} mnemonic Kava address mnemonic
   * @return {Promise}
   */
  async initClient() {
    if (!this.lcdURL) {
      throw new Error("chain's rest-server url is required");
    }
    if (!this.mnemonic) {
      throw new Error('bidding address mnemonic is required');
    }

    // Initiate and set Kava client
    this.client = new kava.KavaClient(this.lcdURL);
    this.client.setWallet(this.mnemonic);
    this.client.setBroadcastMode('async');
    try {
      await this.client.initChain();
    } catch (e) {
      console.log(`Error: cannot connect to lcd server: ${e}`);
      return;
    }
    return this;
  }

  /**
   * check if the bot bids on auctions of the input type
   * @param {String} auctionType the type of auction
   * @returns {boolean}
   */
  checkAuctionParticipation(auctionType) {
    return this.auctionTypes.includes(auctionType);
  }

  /**
   * check if the collateral auction denom is one that the bot bids on
   * @param {string} denom the denom of the collateral being auction
   * @returns {boolean}
   */
  checkCollateralAuctionDenom(denom) {
    return this.collaterals.includes(denom);
  }

  /**
   * check if the current auction bidder is one that the bot bids against
   * @param {string} bidder the bech32 encoded address of the current bidder
   * @returns {boolean}
   */
  checkCompetitiveAuction(bidder) {
    if (bidder !== this.client.wallet.address) {
      return !this.ignoredAddresses.includes(bidder);
    }
    return false;
  }

  /**
   * gets the conversion factor of the input collateral denom
   * @param {string} denom collateral denom
   * @returns {Promise<Number> || Promise<undefined>}
   */
  async getCollateralConversionFactor(denom) {
    const params = await this.client.getParamsCDP();
    const collateralParam = params.collateral_params.find(
      (cp) => cp.denom === denom
    );
    if (!collateralParam) {
      console.log(
        `attempt to fetch conversion factor for invalid collateral ${denom}`
      );
      return;
    }
    return Number.parseInt(collateralParam.conversion_factor);
  }

  /**
   * gets the conversion factor of the input debt denom
   * @param {string} denom debt denom
   * @returns {Promise<Number> || Promise<undefined>}
   */
  async getDebtConversionFactor(denom) {
    const params = await this.client.getParamsCDP();
    if (params.debt_param.denom !== denom) {
      console.log(
        `attempt to fetch conversion factor for invalid debt ${denom}`
      );
      return;
    }
    return Number.parseInt(params.debt_param.conversion_factor);
  }

  /**
   * gets the min bid increment parameter of the input auction type
   * @param {string} auctionType auction type
   * @returns {Promise<Number> || Promise<undefined>}
   */
  async getMinBidIncrement(auctionType) {
    const params = await this.client.getParamsAuction();
    switch (auctionType) {
      case 'collateral':
        return Number.parseFloat(params.increment_collateral);
      case 'debt':
        return Number.parseFloat(params.increment_debt);
      case 'surplus':
        return Number.parseFloat(params.increment_surplus);
      default:
        console.log(
          `couldn't fetch min bid increment for invalid auction type ${auctionType}`
        );
        return;
    }
  }

  /**
   * calculates the next minimum bid and lot amount for the input collateral auction
   * @param {object} auction object - must be a collateral auction
   * @param {number} increment - the percentage amount the bid must be incremented or the lot must be decremented to be accepted by the blockchain
   * @returns {array[ number, number ] || undefined}
   */
  calculateNextBidAndLot(auction, increment) {
    const currentBid = Number.parseInt(
      auction.auction.value.base_auction.bid.amount
    );
    const currentLot = Number.parseInt(
      auction.auction.value.base_auction.lot.amount
    );
    const maxBid = Number.parseInt(auction.auction.value.max_bid.amount);
    switch (auction.phase) {
      case 'forward':
        const newMinBid = Math.max(
          Math.ceil(currentBid + currentBid * increment),
          1
        );
        const initialBid = Math.ceil(maxBid * this.initialBidForward);
        const nextBid = Math.max(newMinBid, initialBid);
        return [Math.min(maxBid, nextBid), currentLot];
      case 'reverse':
        return [maxBid, Math.floor(currentLot - currentLot * increment)];
      default:
        console.log(
          `attempt to calculate next bid and lot for invalid auction phase ${auction.phase}`
        );
        return;
    }
  }

  /**
   * checks if the input coins are greater than or equal to the input amount
   * @param {object} coins coins object that represents the wallet's balance
   * @param {number} amount the amount of coins the wallet must have
   * @param {string} denom the denom that is being spent
   * @returns {boolean}
   */
  checkBalance(coins, amount, denom) {
    const balance = coins.find((coin) => coin.denom === denom);
    if (typeof balance === 'undefined') {
      return false;
    }
    return Number.parseInt(balance.amount) >= amount;
  }

  /**
   * checks if the auction bot's wallet has sufficient funds to bid
   * @param {object} auction auction object - must be a collateral auction
   * @returns {Promise<boolean>}
   */
  async checkSufficientFunds(auction, bidAmount) {
    const account = await this.client.getAccount(this.client.wallet.address);
    const coins = utils.filterObjectByProperty(account, 'coins').coins;
    switch (auction.phase) {
      case 'forward':
        return this.checkBalance(
          coins,
          bidAmount,
          auction.auction.value.base_auction.bid.denom
        );
      case 'reverse':
        return this.checkBalance(
          coins,
          auction.auction.value.max_bid.amount,
          auction.auction.value.max_bid.denom
        );
      default:
        console.log(`invalid auction phase ${auction.phase}`);
        return false;
    }
  }

  /**
   * checks if the marginal profit of bidding is sufficient for the bot to bid on the input auction
   * @param {object} auction auction object - must be a collateral auction
   * @param {number} bidAmount the amount that is being bid
   * @param {number} lotAmount the lot that is up for auction
   * @returns {Promise<boolean>}
   */
  async checkBidMargin(auction, bidAmount, lotAmount) {
    // return true;
    const conversionFactorBid = await this.getDebtConversionFactor(
      auction.auction.value.base_auction.bid.denom
    );
    const conversionFactorLot = await this.getCollateralConversionFactor(
      auction.auction.value.base_auction.lot.denom
    );
    let denom;
    switch (auction.auction.value.base_auction.lot.denom) {
      case 'btcb':
        denom = 'btc';
        break;
      case 'ukava':
        denom = 'kava';
        break;
      default:
        denom = auction.auction.value.base_auction.lot.denom;
        break;
    }
    const price = await prices.getPrice(denom);
    const bidValue = Math.max(bidAmount * 10 ** -conversionFactorBid, 0.001);
    const lotValue =
      price * (Number.parseInt(lotAmount) * 10 ** -conversionFactorLot);
    console.log(price, bidValue, lotValue);
    console.log('1 - bidValue / lotValue ', 1 - bidValue / lotValue);
    console.log(
      'Number.parseFloat(this.reverseBidMargin)',
      Number.parseFloat(this.reverseBidMargin)
    );
    switch (auction.phase) {
      case 'forward':
        if (
          Number.parseFloat(this.forwardBidMax) *
            Number.parseInt(auction.auction.value.max_bid.amount) <
          bidAmount
        ) {
          return false;
        }
        return (
          1 - bidValue / lotValue > Number.parseFloat(this.forwardBidMargin)
        );
      case 'reverse':
        return (
          1 - bidValue / lotValue > Number.parseFloat(this.reverseBidMargin)
        );
      default:
        console.log(`invalid auction phase ${auction.phase}`);
        return false;
    }
  }

  async checkForNewBids() {
    const accountData = await kava.tx.loadMetaData(
      this.client.wallet.address,
      this.client.baseURI
    );
    var i = 0;
    const auctions = await this.client.getAuctions();
    await utils.asyncForEach(auctions, async (auction) => {
      console.log(`checking if bot should bid on auction
      ${JSON.stringify(auction, undefined, 2)}`);
      const id = auction.auction.value.base_auction.id;
      if (!this.checkAuctionParticipation(auction.type)) {
        console.log(
          `auction ID ${id}: no bid: bot does not participate in ${auction.type} auctions`
        );
        return;
      }
      if (
        !this.checkCompetitiveAuction(auction.auction.value.base_auction.bidder)
      ) {
        console.log(
          `auction ID ${id}: no bid: bot does not bid against ${auction.auction.value.base_auction.bidder}`
        );
        return;
      }
      switch (auction.type) {
        case 'collateral':
          const placedBid = await this.checkPlaceBidCollateral(
            auction,
            accountData,
            i
          );
          if (placedBid) {
            i++;
          }
          return;
        default:
          // TODO debt, surplus
          return;
      }
    });
  }

  async checkPlaceBidCollateral(auction, accountData, sequenceCounter) {
    const id = auction.auction.value.base_auction.id;
    // if (
    //   !this.checkCollateralAuctionDenom(
    //     auction.auction.value.base_auction.lot.denom
    //   )
    // ) {
    //   console.log(
    //     `auction ID ${id}: no bid: bot does not bid on ${auction.auction.value.base_auction.lot.denom} auctions`
    //   );
    //   return false;
    // }
    const bidIncrement = await this.getMinBidIncrement(auction.type);
    const [nextBid, nextLot] = this.calculateNextBidAndLot(
      auction,
      bidIncrement
    );
    if (!(await this.checkSufficientFunds(auction, nextBid))) {
      console.log(`auction ID ${id}: no bid: insufficient funds`);
      return false;
    }
    if (!(await this.checkBidMargin(auction, nextBid, nextLot))) {
      console.log(`auction ID ${id}: no bid: insufficient profit margin`);
      return false;
    }
    const sequence = String(Number(accountData.sequence) + sequenceCounter);
    let coins = kava.utils.formatCoin(
      String(nextBid),
      auction.auction.value.base_auction.bid.denom
    );
    if (auction.phase === 'reverse') {
      coins = kava.utils.formatCoin(
        String(nextLot),
        auction.auction.value.base_auction.lot.denom
      );
    }
    console.log(`
    proposed bid:
    auction id: ${auction.auction.value.base_auction.id}
    coins: ${JSON.stringify(coins)}
    sequence: ${sequence}
    `);
    let txHash;
    try {
      txHash = await this.client.placeBid(
        auction.auction.value.base_auction.id,
        coins,
        undefined,
        sequence
      );
      console.log(`transaction hash: ${txHash}`);
    } catch (e) {
      console.log(
        `could not bid on auction ${auction.auction.value.base_auction.id}`
      );
      console.log(e);
      return false;
    }
    try {
      await this.client.checkTxHash(txHash, 25000);
    } catch (e) {
      console.log(`Tx not accepted by chain: ${e}`);
    }
    return true;
  }

  async run() {
    cron.schedule(this.crontab, async () => {
      await this.checkForNewBids();
    });
  }
}

module.exports.AuctionBot = AuctionBot;
