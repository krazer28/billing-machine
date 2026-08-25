/**
 * script.js
 * -----------------------------------------------------------------------
 * Smart Product Billing — app logic.
 *
 * Organized in five parts:
 *   1. Config + DOM references + app state
 *   2. OpenCV.js bootstrap + reference-image feature indexing
 *   3. Camera control + the recognition loop
 *   4. Customer measure (weight/amount) + add-to-bill flow
 *   5. Billing list (render, edit, delete, clear, grand total)
 *
 * Recognition approach (documented for future upgrade):
 *   Each reference product image is converted to grayscale once at
 *   startup and its ORB keypoints/descriptors are computed and cached.
 *   Live camera frames are sampled periodically (not on every animation
 *   frame — see FRAME_PROCESS_INTERVAL_MS), converted to grayscale, and
 *   matched against every cached reference using a brute-force Hamming
 *   matcher. The reference with the most "good" matches (distance below
 *   GOOD_MATCH_DISTANCE) wins, provided it clears MIN_GOOD_MATCHES.
 *   This whole block (buildReferenceIndex + matchFrameAgainstReferences)
 *   is the only place that needs to change to swap in a trained
 *   AI/ML model later — everything downstream just consumes
 *   { product, confidencePercent }.
 *
 * Reference images are loaded defensively: a product with a missing or
 * not-yet-added photo (see images/README.txt) is simply skipped when
 * building the index instead of breaking recognition for every other
 * product.
 * -----------------------------------------------------------------------
 */

(function () {
  "use strict";

  // =========================================================================
  // 1. CONFIG + DOM REFERENCES + STATE
  // =========================================================================

  const CONFIG = {
    FRAME_PROCESS_INTERVAL_MS: 350, // throttle: don't run recognition on every rAF tick
    GOOD_MATCH_DISTANCE: 50, // ORB/Hamming distance below which a match counts as "good" (0-256 scale)
    MIN_GOOD_MATCHES: 12, // minimum good matches required to accept a recognition
    CONFIDENCE_DISPLAY_SCALE: 40, // good-match count that maps to ~100% on the confidence readout
    ORB_FEATURES: 500,
  };

  const RecognitionState = {
    IDLE: "idle", // camera off
    SCANNING: "scanning", // camera on, actively looking for a product
    WAITING_FOR_MEASURE: "waiting", // product recognized, waiting on weight/amount + Add/Cancel
  };

  const MeasureMode = {
    WEIGHT: "weight",
    AMOUNT: "amount",
  };

  const dom = {
    video: document.getElementById("video"),
    workCanvas: document.getElementById("workCanvas"),
    scannerViewport: document.querySelector(".scanner-viewport"),
    startCameraBtn: document.getElementById("startCameraBtn"),
    stopCameraBtn: document.getElementById("stopCameraBtn"),
    recognitionStatus: document.getElementById("recognitionStatus"),
    confidenceText: document.getElementById("confidenceText"),
    stateTag: document.getElementById("stateTag"),
    errorBanner: document.getElementById("errorBanner"),
    cvStatus: document.getElementById("cvStatus"),
    cvStatusText: document.getElementById("cvStatusText"),

    productEmptyState: document.getElementById("productEmptyState"),
    productDetails: document.getElementById("productDetails"),
    productImage: document.getElementById("productImage"),
    productImagePlaceholder: document.getElementById("productImagePlaceholder"),
    productName: document.getElementById("productName"),
    productPricePerGramLine: document.getElementById("productPricePerGramLine"),
    productBasePackRow: document.getElementById("productBasePackRow"),
    productBasePackLine: document.getElementById("productBasePackLine"),

    measureByWeightBtn: document.getElementById("measureByWeightBtn"),
    measureByAmountBtn: document.getElementById("measureByAmountBtn"),
    weightModeField: document.getElementById("weightModeField"),
    amountModeField: document.getElementById("amountModeField"),
    weightInput: document.getElementById("weightInput"),
    amountInput: document.getElementById("amountInput"),
    measureError: document.getElementById("measureError"),
    previewWeight: document.getElementById("previewWeight"),
    previewAmount: document.getElementById("previewAmount"),
    addToBillBtn: document.getElementById("addToBillBtn"),
    cancelProductBtn: document.getElementById("cancelProductBtn"),

    billBody: document.getElementById("billBody"),
    billEmptyRow: document.getElementById("billEmptyRow"),
    grandTotal: document.getElementById("grandTotal"),
    clearBillBtn: document.getElementById("clearBillBtn"),

    confirmModal: document.getElementById("confirmModal"),
    confirmModalText: document.getElementById("confirmModalText"),
    confirmModalOk: document.getElementById("confirmModalOk"),
    confirmModalCancel: document.getElementById("confirmModalCancel"),
  };

  const state = {
    cvReady: false,
    referenceIndex: null, // built once cv + images are ready: [{ product, keypoints, descriptors }]
    stream: null,
    recognitionState: RecognitionState.IDLE,
    currentProduct: null,
    measureMode: MeasureMode.WEIGHT,
    lastFrameProcessTime: 0,
    rafHandle: null,
    billItems: [], // { lineId, product, weightGrams, amount }
    nextLineId: 1,
  };

  // =========================================================================
  // 2. OPENCV.JS BOOTSTRAP + REFERENCE INDEX
  // =========================================================================

  function setCvStatus(text, mode) {
    dom.cvStatusText.textContent = text;
    dom.cvStatus.removeAttribute("data-ready");
    dom.cvStatus.removeAttribute("data-failed");
    if (mode === "ready") dom.cvStatus.setAttribute("data-ready", "true");
    if (mode === "failed") dom.cvStatus.setAttribute("data-failed", "true");
  }

  function waitForOpenCv() {
    const start = Date.now();
    const TIMEOUT_MS = 20000;

    const poll = setInterval(() => {
      if (window.__openCvScriptFailed) {
        clearInterval(poll);
        setCvStatus("Vision engine failed to load — check your connection", "failed");
        showError(
          "OpenCV.js could not be loaded from the CDN. Recognition is unavailable until this is fixed (check network access and reload)."
        );
        return;
      }
      if (window.cv && typeof window.cv.Mat === "function") {
        clearInterval(poll);
        onOpenCvReady();
        return;
      }
      if (Date.now() - start > TIMEOUT_MS) {
        clearInterval(poll);
        setCvStatus("Vision engine timed out", "failed");
        showError("OpenCV.js took too long to load. Try reloading the page.");
      }
    }, 100);
  }

  function onOpenCvReady() {
    if (window.cv.getBuildInformation) {
      finishCvSetup();
    } else {
      window.cv["onRuntimeInitialized"] = finishCvSetup;
    }
  }

  function finishCvSetup() {
    setCvStatus("Vision engine ready", "ready");
    state.cvReady = true;
    buildReferenceIndex();
  }

  /**
   * Loads every product's reference image and computes ORB
   * keypoints/descriptors once. A product whose image is missing or
   * fails to load is skipped (with a console warning) rather than
   * blocking recognition for every other product — this matters here
   * because images/ ships empty and photos are added one at a time.
   */
  function buildReferenceIndex() {
    const orb = new cv.ORB(CONFIG.ORB_FEATURES);

    const loaders = PRODUCTS.map((product) =>
      loadImageElement(product.image)
        .then((imgEl) => ({ product, imgEl }))
        .catch((err) => {
          console.warn("Skipping reference image for", product.name, "-", err.message);
          return null;
        })
    );

    Promise.all(loaders).then((loaded) => {
      const index = [];
      const missing = [];

      loaded.forEach((entry) => {
        if (!entry) return;
        const { product, imgEl } = entry;
        const mat = cv.imread(imgEl);
        const gray = new cv.Mat();
        cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);

        const keypoints = new cv.KeyPointVector();
        const descriptors = new cv.Mat();
        orb.detect(gray, keypoints);
        orb.compute(gray, keypoints, descriptors);

        index.push({ product, keypoints, descriptors });
        mat.delete();
        gray.delete();
      });

      PRODUCTS.forEach((p) => {
        if (!index.find((entry) => entry.product.id === p.id)) missing.push(p.name);
      });

      state.referenceIndex = index;
      orb.delete();

      if (missing.length > 0) {
        showError(
          "No reference photo yet for: " +
            missing.join(", ") +
            ". Add images to /images (see images/README.txt) — those products can't be recognized until then."
        );
      }
    });
  }

  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("could not load " + src));
      img.src = src;
    });
  }

  function matchFrameAgainstReferences(frameGray) {
    if (!state.referenceIndex || state.referenceIndex.length === 0) return null;

    const orb = new cv.ORB(CONFIG.ORB_FEATURES);
    const frameKeypoints = new cv.KeyPointVector();
    const frameDescriptors = new cv.Mat();
    orb.detect(frameGray, frameKeypoints);
    orb.compute(frameGray, frameKeypoints, frameDescriptors);

    let best = null;

    if (frameDescriptors.rows > 0) {
      const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);

      for (const ref of state.referenceIndex) {
        if (ref.descriptors.rows === 0) continue;

        const matches = new cv.DMatchVector();
        matcher.match(frameDescriptors, ref.descriptors, matches);

        let goodMatches = 0;
        for (let i = 0; i < matches.size(); i++) {
          if (matches.get(i).distance < CONFIG.GOOD_MATCH_DISTANCE) goodMatches++;
        }
        matches.delete();

        if (!best || goodMatches > best.goodMatches) {
          best = { product: ref.product, goodMatches };
        }
      }
      matcher.delete();
    }

    frameKeypoints.delete();
    frameDescriptors.delete();
    orb.delete();

    if (!best || best.goodMatches < CONFIG.MIN_GOOD_MATCHES) return null;

    const confidencePercent = Math.min(100, Math.round((best.goodMatches / CONFIG.CONFIDENCE_DISPLAY_SCALE) * 100));
    return { product: best.product, confidencePercent };
  }

  // =========================================================================
  // 3. CAMERA CONTROL + RECOGNITION LOOP
  // =========================================================================

  async function startCamera() {
    hideError();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError("This browser does not support camera access.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      state.stream = stream;
      dom.video.srcObject = stream;
      await dom.video.play();

      dom.scannerViewport.classList.add("active");
      dom.startCameraBtn.disabled = true;
      dom.stopCameraBtn.disabled = false;

      setRecognitionState(RecognitionState.SCANNING);
      setStatusText("Scanning...");
      scheduleFrameLoop();
    } catch (err) {
      console.error(err);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        showError("Camera permission was denied. Allow camera access in your browser settings and try again.");
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
        showError("No camera was found on this device.");
      } else {
        showError("Could not start the camera: " + err.message);
      }
    }
  }

  function stopCamera() {
    if (state.rafHandle) cancelAnimationFrame(state.rafHandle);
    state.rafHandle = null;

    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
    }
    dom.video.srcObject = null;

    dom.scannerViewport.classList.remove("active");
    dom.startCameraBtn.disabled = false;
    dom.stopCameraBtn.disabled = true;

    setRecognitionState(RecognitionState.IDLE);
    setStatusText("Camera Ready");
    dom.confidenceText.textContent = "";
    resetRecognizedProduct();
  }

  function scheduleFrameLoop() {
    const loop = (timestamp) => {
      if (!state.stream) return;

      if (
        state.cvReady &&
        state.referenceIndex &&
        state.recognitionState === RecognitionState.SCANNING &&
        timestamp - state.lastFrameProcessTime > CONFIG.FRAME_PROCESS_INTERVAL_MS
      ) {
        state.lastFrameProcessTime = timestamp;
        processFrame();
      }
      state.rafHandle = requestAnimationFrame(loop);
    };
    state.rafHandle = requestAnimationFrame(loop);
  }

  /**
   * Grabs the current video frame, runs recognition, and updates the UI.
   * All cv.Mat objects created here are deleted before returning to avoid
   * leaking WASM heap memory across the continuous camera loop.
   */
  function processFrame() {
    if (dom.video.readyState < 2) return;

    const canvas = dom.workCanvas;
    const w = dom.video.videoWidth;
    const h = dom.video.videoHeight;
    if (!w || !h) return;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(dom.video, 0, 0, w, h);

    let frameMat;
    let frameGray;
    try {
      frameMat = cv.imread(canvas);
      frameGray = new cv.Mat();
      cv.cvtColor(frameMat, frameGray, cv.COLOR_RGBA2GRAY);

      const result = matchFrameAgainstReferences(frameGray);

      if (result) {
        onProductRecognized(result.product, result.confidencePercent);
      } else {
        setStatusText("Product Not Recognized");
        dom.confidenceText.textContent = "";
      }
    } catch (err) {
      console.error("Recognition processing failure:", err);
      showError("Recognition processing failed on this frame. Retrying…");
    } finally {
      if (frameMat) frameMat.delete();
      if (frameGray) frameGray.delete();
    }
  }

  function onProductRecognized(product, confidencePercent) {
    // Duplicate-recognition prevention: once a product is on screen we
    // stop reacting to further recognitions until the user acts on it.
    if (state.recognitionState !== RecognitionState.SCANNING) return;

    state.currentProduct = product;
    setRecognitionState(RecognitionState.WAITING_FOR_MEASURE);
    setStatusText("Product Recognized");
    dom.confidenceText.textContent = "Confidence " + confidencePercent + "%";
    showRecognizedProduct(product);
  }

  // =========================================================================
  // 4. CUSTOMER MEASURE (WEIGHT/AMOUNT) + ADD-TO-BILL
  // =========================================================================

  function showRecognizedProduct(product) {
    dom.productEmptyState.hidden = true;
    dom.productDetails.hidden = false;

    dom.productImage.hidden = true;
    dom.productImagePlaceholder.hidden = false;
    dom.productImage.onload = () => {
      dom.productImage.hidden = false;
      dom.productImagePlaceholder.hidden = true;
    };
    dom.productImage.onerror = () => {
      dom.productImage.hidden = true;
      dom.productImagePlaceholder.hidden = false;
    };
    dom.productImage.alt = product.name;
    dom.productImage.src = product.image;

    dom.productName.textContent = product.name;
    dom.productPricePerGramLine.textContent = "1g = \u20B9" + getPricePerGram(product).toFixed(2);

    if (product.pricingType === "base") {
      dom.productBasePackRow.hidden = false;
      dom.productBasePackLine.textContent = product.baseWeight + "g = \u20B9" + product.basePrice.toFixed(2);
    } else {
      dom.productBasePackRow.hidden = true;
    }

    setMeasureMode(MeasureMode.WEIGHT);
    dom.measureByWeightBtn.disabled = false;
    dom.measureByAmountBtn.disabled = false;
    dom.weightInput.disabled = false;
    dom.amountInput.disabled = false;
    dom.weightInput.value = "";
    dom.amountInput.value = "";
    dom.measureError.hidden = true;
    updateCalcPreview();
    dom.addToBillBtn.disabled = true;
    dom.cancelProductBtn.disabled = false;
    dom.weightInput.focus();
  }

  function resetRecognizedProduct() {
    state.currentProduct = null;
    dom.productEmptyState.hidden = false;
    dom.productDetails.hidden = true;

    dom.measureByWeightBtn.disabled = true;
    dom.measureByAmountBtn.disabled = true;
    dom.weightInput.disabled = true;
    dom.amountInput.disabled = true;
    dom.weightInput.value = "";
    dom.amountInput.value = "";
    dom.measureError.hidden = true;
    setMeasureMode(MeasureMode.WEIGHT);
    updateCalcPreview();
    dom.addToBillBtn.disabled = true;
    dom.cancelProductBtn.disabled = true;
  }

  function setMeasureMode(mode) {
    state.measureMode = mode;
    const isWeight = mode === MeasureMode.WEIGHT;

    dom.measureByWeightBtn.classList.toggle("is-active", isWeight);
    dom.measureByWeightBtn.setAttribute("aria-selected", String(isWeight));
    dom.measureByAmountBtn.classList.toggle("is-active", !isWeight);
    dom.measureByAmountBtn.setAttribute("aria-selected", String(!isWeight));

    dom.weightModeField.hidden = !isWeight;
    dom.amountModeField.hidden = isWeight;
    dom.measureError.hidden = true;
  }

  function validatePositiveNumber(rawValue, label) {
    if (rawValue === "" || rawValue === null) {
      return { valid: false, message: "Enter " + label + " to continue." };
    }
    const value = Number(rawValue);
    if (Number.isNaN(value)) {
      return { valid: false, message: label + " must be a number." };
    }
    if (value < 0) {
      return { valid: false, message: label + " cannot be negative." };
    }
    if (value === 0) {
      return { valid: false, message: label + " cannot be zero." };
    }
    return { valid: true, value };
  }

  /**
   * Recomputes the "other" value from whichever field the customer is
   * using, and drives the live preview + the Add to Bill enabled state.
   * Returns the resolved { weightGrams, amount } when valid, or null.
   */
  function updateCalcPreview() {
    const product = state.currentProduct;
    if (!product) {
      dom.previewWeight.textContent = "0.00g";
      dom.previewAmount.textContent = "\u20B90.00";
      return null;
    }

    const isWeight = state.measureMode === MeasureMode.WEIGHT;
    const rawValue = isWeight ? dom.weightInput.value : dom.amountInput.value;
    const label = isWeight ? "a weight" : "an amount";
    const result = validatePositiveNumber(rawValue, label);

    if (!result.valid) {
      dom.measureError.textContent = result.message;
      dom.measureError.hidden = rawValue === ""; // don't nag before they type anything
      dom.previewWeight.textContent = "0.00g";
      dom.previewAmount.textContent = "\u20B90.00";
      dom.addToBillBtn.disabled = true;
      return null;
    }

    dom.measureError.hidden = true;

    let weightGrams, amount;
    if (isWeight) {
      weightGrams = result.value;
      amount = calculateAmountFromWeight(product, weightGrams);
    } else {
      amount = result.value;
      weightGrams = calculateWeightFromAmount(product, amount);
    }

    dom.previewWeight.textContent = weightGrams.toFixed(2) + "g";
    dom.previewAmount.textContent = "\u20B9" + amount.toFixed(2);
    dom.addToBillBtn.disabled = false;

    return { weightGrams, amount };
  }

  function addCurrentProductToBill() {
    const resolved = updateCalcPreview();
    if (!resolved || !state.currentProduct) {
      dom.measureError.hidden = false;
      if (!dom.measureError.textContent) dom.measureError.textContent = "Enter a valid weight or amount first.";
      return;
    }

    const product = state.currentProduct;

    state.billItems.push({
      lineId: state.nextLineId++,
      product,
      weightGrams: resolved.weightGrams,
      amount: resolved.amount,
    });
    renderBill();

    resetRecognizedProduct();
    setRecognitionState(RecognitionState.SCANNING);
    setStatusText("Scanning...");
    dom.confidenceText.textContent = "";
  }

  function cancelCurrentProduct() {
    resetRecognizedProduct();
    setRecognitionState(RecognitionState.SCANNING);
    setStatusText("Scanning...");
    dom.confidenceText.textContent = "";
  }

  // =========================================================================
  // 5. BILLING LIST
  // =========================================================================

  function renderBill() {
    dom.billBody.querySelectorAll("tr[data-line-id]").forEach((row) => row.remove());
    dom.billEmptyRow.hidden = state.billItems.length > 0;

    state.billItems.forEach((item, index) => {
      const row = document.createElement("tr");
      row.dataset.lineId = String(item.lineId);
      row.innerHTML =
        "<td>" +
        (index + 1) +
        "</td>" +
        "<td>" +
        escapeHtml(item.product.name) +
        "</td>" +
        "<td>\u20B9" +
        getPricePerGram(item.product).toFixed(2) +
        "/g</td>" +
        '<td class="qty-cell" data-action="edit-weight" title="Click to edit">' +
        item.weightGrams.toFixed(2) +
        "g</td>" +
        "<td>\u20B9" +
        item.amount.toFixed(2) +
        "</td>" +
        '<td><button class="btn-icon" data-action="delete" title="Delete item">\u2715</button></td>';
      dom.billBody.appendChild(row);
    });

    updateGrandTotal();
  }

  function updateGrandTotal() {
    const grandTotal = state.billItems.reduce((total, item) => total + item.amount, 0);
    dom.grandTotal.textContent = "\u20B9" + grandTotal.toFixed(2);
  }

  function onBillBodyClick(evt) {
    const button = evt.target.closest("button[data-action='delete']");
    if (button) {
      const row = button.closest("tr[data-line-id]");
      const lineId = Number(row.dataset.lineId);
      showConfirm("Delete this item from the bill?", () => {
        state.billItems = state.billItems.filter((item) => item.lineId !== lineId);
        renderBill();
      });
      return;
    }

    const qtyCell = evt.target.closest("td[data-action='edit-weight']");
    if (qtyCell) {
      startEditingWeight(qtyCell);
    }
  }

  function startEditingWeight(qtyCell) {
    if (qtyCell.querySelector("input")) return;

    const row = qtyCell.closest("tr[data-line-id]");
    const lineId = Number(row.dataset.lineId);
    const item = state.billItems.find((i) => i.lineId === lineId);
    if (!item) return;

    const originalText = qtyCell.textContent;
    qtyCell.textContent = "";
    const input = document.createElement("input");
    input.type = "number";
    input.className = "qty-edit-input";
    input.min = "0";
    input.step = "any";
    input.value = item.weightGrams;
    qtyCell.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const result = validatePositiveNumber(input.value, "a weight");
      if (!result.valid) {
        qtyCell.textContent = originalText; // silently revert on invalid edit
        return;
      }
      item.weightGrams = result.value;
      item.amount = calculateAmountFromWeight(item.product, result.value);
      renderBill();
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") {
        qtyCell.textContent = originalText;
      }
    });
  }

  function clearBill() {
    if (state.billItems.length === 0) return;
    showConfirm("Clear the entire bill? This cannot be undone.", () => {
      state.billItems = [];
      state.nextLineId = 1;
      renderBill();
      resetRecognizedProduct();
      if (state.stream) {
        setRecognitionState(RecognitionState.SCANNING);
        setStatusText("Scanning...");
      }
    });
  }

  // =========================================================================
  // SHARED UI HELPERS
  // =========================================================================

  function setRecognitionState(newState) {
    state.recognitionState = newState;
    dom.stateTag.dataset.state = newState;
    const labels = {
      [RecognitionState.IDLE]: "Camera Off",
      [RecognitionState.SCANNING]: "Scanning",
      [RecognitionState.WAITING_FOR_MEASURE]: "Awaiting Action",
    };
    dom.stateTag.textContent = labels[newState] || newState;
  }

  function setStatusText(text) {
    dom.recognitionStatus.textContent = text;
  }

  function showError(message) {
    dom.errorBanner.textContent = message;
    dom.errorBanner.hidden = false;
  }

  function hideError() {
    dom.errorBanner.hidden = true;
  }

  let pendingConfirmAction = null;

  function showConfirm(message, onConfirm) {
    dom.confirmModalText.textContent = message;
    pendingConfirmAction = onConfirm;
    dom.confirmModal.hidden = false;
  }

  function hideConfirm() {
    dom.confirmModal.hidden = true;
    pendingConfirmAction = null;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // =========================================================================
  // EVENT WIRING
  // =========================================================================

  dom.startCameraBtn.addEventListener("click", startCamera);
  dom.stopCameraBtn.addEventListener("click", stopCamera);
  dom.measureByWeightBtn.addEventListener("click", () => {
    setMeasureMode(MeasureMode.WEIGHT);
    updateCalcPreview();
  });
  dom.measureByAmountBtn.addEventListener("click", () => {
    setMeasureMode(MeasureMode.AMOUNT);
    updateCalcPreview();
  });
  dom.weightInput.addEventListener("input", updateCalcPreview);
  dom.amountInput.addEventListener("input", updateCalcPreview);
  dom.addToBillBtn.addEventListener("click", addCurrentProductToBill);
  dom.cancelProductBtn.addEventListener("click", cancelCurrentProduct);
  dom.billBody.addEventListener("click", onBillBodyClick);
  dom.clearBillBtn.addEventListener("click", clearBill);

  dom.confirmModalOk.addEventListener("click", () => {
    const action = pendingConfirmAction;
    hideConfirm();
    if (action) action();
  });
  dom.confirmModalCancel.addEventListener("click", hideConfirm);

  window.addEventListener("beforeunload", () => {
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  });

  // =========================================================================
  // INIT
  // =========================================================================

  setCvStatus("Loading vision engine…", null);
  waitForOpenCv();
  renderBill();
})();