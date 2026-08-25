/**
 * products.js
 * -----------------------------------------------------------------------
 * Product database for the Smart Product Billing app.
 *
 * Two pricing types are supported:
 *
 *   "base"    — a fixed pack: baseWeight grams cost basePrice rupees.
 *               pricePerGram is DERIVED: basePrice / baseWeight.
 *   "perGram" — price is already given as rupees per gram
 *               (the "1g = ₹X" / "1:X" format).
 *
 * Both types are normalized to a single pricePerGram by getPricePerGram()
 * below, so every other part of the app (recognition card, live
 * calculation, billing table) only ever deals with one number and never
 * needs to know which pricing type a product uses.
 *
 * To add a new product later:
 *   1. Drop a reference photo into /images (see images/README.txt)
 *   2. Add one entry below, using whichever pricingType fits
 *   3. Reload — no other code needs to change
 * -----------------------------------------------------------------------
 */

const PRODUCTS = [
  {
    id: 1,
    name: "Bikaneri Bhujia",
    pricingType: "base",
    baseWeight: 400, // grams
    basePrice: 90, // rupees
    image: "bikaneri-bhujia.png",
  },
  {
    id: 2,
    name: "Coffee - Small",
    pricingType: "base",
    baseWeight: 20,
    basePrice: 40,
    image: "coffee-small.jfif",
  },
  {
    id: 3,
    name: "Coffee - Large",
    pricingType: "base",
    baseWeight: 50,
    basePrice: 80,
    image: "images/coffee-large.jpg",
  },
  {
    id: 4,
    name: "Paras Dana Chai",
    pricingType: "perGram",
    pricePerGram: 0.28,
    image: "images/paras-dana-chai.jpg",
  },
  {
    id: 5,
    name: "Paras Medium Chai",
    pricingType: "perGram",
    pricePerGram: 0.28,
    image: "images/paras-medium-chai.jpg",
  },
  {
    id: 6,
    name: "Amar Gold Chai",
    pricingType: "perGram",
    pricePerGram: 0.32,
    image: "images/amar-gold-chai.jpg",
  },
  {
    id: 7,
    name: "Chai Masala",
    pricingType: "perGram",
    pricePerGram: 1,
    image: "images/chai-masala.jpg",
  },
  {
    id: 8,
    name: "Green Tea",
    pricingType: "perGram",
    pricePerGram: 1.6,
    image: "images/green-tea.jpg",
  },
];

/**
 * Single source of truth for "how much is one gram of this product".
 * "base" products derive it from basePrice/baseWeight; "perGram"
 * products already store it directly.
 */
function getPricePerGram(product) {
  if (product.pricingType === "perGram") {
    return product.pricePerGram;
  }
  return product.basePrice / product.baseWeight;
}

/** Weight (grams) entered by the customer -> amount (rupees). */
function calculateAmountFromWeight(product, weightGrams) {
  return weightGrams * getPricePerGram(product);
}

/** Amount (rupees) requested by the customer -> weight (grams). */
function calculateWeightFromAmount(product, amount) {
  return amount / getPricePerGram(product);
}