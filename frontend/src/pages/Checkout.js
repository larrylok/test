import React, { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  Loader2,
  AlertCircle,
  Copy as CopyIcon,
  MapPin,
  Phone as PhoneIcon,
  ChevronRight,
} from "lucide-react";
import storage from "@/utils/storage";
import analytics from "@/utils/analytics";
import { toast } from "sonner";
import api from "../api";

// ==================== HELPERS ====================

function buildOrderNumber() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `LX-${ymd}-${rand}`;
}

function safeStr(x) {
  return String(x ?? "").trim();
}

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function getApiOrigin() {
  const base = String(api?.defaults?.baseURL || "");
  return base.replace(/\/api\/?$/, "");
}

function absolutizeMaybe(url) {
  const u = String(url || "");
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  const origin = getApiOrigin();
  return origin ? `${origin}${u}` : u;
}

function pickDefaultImage(product) {
  const primary = safeStr(product?.primaryImage);
  if (primary) return primary;
  const imgs = safeArr(product?.images);
  return imgs[0] || "";
}

// ==================== VALIDATION ====================

const validateEmail = (email) => {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
};

const validatePhone = (phone) => {
  // Kenya format: 254712345678, +254712345678, 0712345678
  const re = /^(\+254|254|0)[7-9]\d{8}$/;
  return re.test(safeStr(phone).replace(/\s/g, ""));
};

const validatePostalCode = (code) => {
  return safeStr(code).length >= 3 && safeStr(code).length <= 10;
};

// ==================== MAIN COMPONENT ====================

export default function Checkout() {
  const navigate = useNavigate();

  // ---- STATE ----
  const [step, setStep] = useState(1); // 1: Info, 2: Review, 3: Payment, 4: Confirmation
  const [cart, setCart] = useState(null);
  const [products, setProducts] = useState({});
  const [shippingMethods, setShippingMethods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processingPayment, setProcessingPayment] = useState(false);
  const [order, setOrder] = useState(null);
  const [checkingPaymentStatus, setCheckingPaymentStatus] = useState(false);
  const [purchaseTracked, setPurchaseTracked] = useState(false);
  const [errors, setErrors] = useState({});

  // ---- CUSTOMER INFO ----
  const [customerInfo, setCustomerInfo] = useState({
    name: "",
    email: "",
    phone: "",
  });

  // ---- DELIVERY INFO ----
  const [deliveryInfo, setDeliveryInfo] = useState({
    address: "",
    city: "",
    postalCode: "",
    method: "",
    cost: 0,
  });

  // ---- PAYMENT ----
  const [paymentMethod, setPaymentMethod] = useState("mpesa");
  const [mpesaPhone, setMpesaPhone] = useState("");

  // ==================== CALCULATIONS ====================

  const totals = useMemo(() => {
    let subtotal = 0;
    let giftWrapTotal = 0;

    safeArr(cart?.items).forEach((item) => {
      const product = products?.[item.productId];
      if (!product) return;

      const price = safeNum(product.salePrice || product.price || product.basePrice || 0);
      subtotal += price * safeNum(item.quantity, 1);

      if (item.giftWrap) {
        giftWrapTotal += 5 * safeNum(item.quantity, 1); // KES 5 per item
      }
    });

    const shippingCost = safeNum(deliveryInfo.cost, 0);
    const tax = Math.round(subtotal * 0.16); // 16% VAT
    const total = subtotal + giftWrapTotal + shippingCost + tax;

    return {
      subtotal,
      giftWrapTotal,
      shippingCost,
      tax,
      total,
    };
  }, [cart, products, deliveryInfo.cost]);

  // ==================== EFFECTS ============================

  useEffect(() => {
    loadInitialData();
  }, []);

  // Poll for payment status when on payment step
  useEffect(() => {
    if (step !== 3 || !order?.orderNumber) return;

    let mounted = true;
    let intervalId;

    const pollStatus = async () => {
      if (!mounted) return;

      try {
        const res = await api.get(`/orders/track/${order.orderNumber}`);
        if (!mounted || !res?.data) return;

        const latest = res.data;
        setOrder((prev) => ({
          ...(prev || {}),
          ...latest,
          payment: {
            ...(prev?.payment || {}),
            ...(latest.payment || {}),
          },
        }));

        const latestPaymentStatus = safeStr(latest?.payment?.status).toLowerCase();
        const latestOrderStatus = safeStr(latest?.status).toLowerCase();

        const confirmed =
          latestPaymentStatus === "confirmed" ||
          latestPaymentStatus === "completed" ||
          latestOrderStatus === "processing" ||
          latestOrderStatus === "confirmed";

        const failed =
          latestPaymentStatus === "failed" ||
          latestOrderStatus === "payment_failed" ||
          latestOrderStatus === "failed" ||
          latestOrderStatus === "cancelled";

        if (confirmed && !purchaseTracked) {
          try {
            analytics.purchase(
              latest?.id || latest?._id || order?.id,
              safeNum(latest?.total, 0),
              safeArr(latest?.items)
            );
          } catch (e) {
            console.warn("Analytics tracking failed:", e);
          }

          try {
            await storage.set("cart", { items: [], subtotal: 0, total: 0 });
            window.dispatchEvent(new Event("storage-update"));
          } catch (e) {
            console.warn("Failed to clear cart", e);
          }

          setPurchaseTracked(true);
          toast.success("✨ Payment confirmed!");
          setTimeout(() => setStep(4), 500);
        }

        if (failed) {
          toast.error("Payment failed. Please try again.");
        }
      } catch (error) {
        console.error("Payment status check failed:", error);
      }
    };

    // Check immediately, then poll every 5 seconds
    pollStatus();
    intervalId = setInterval(pollStatus, 5000);

    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, [step, order?.orderNumber, purchaseTracked]);

  // ==================== API CALLS ====================

  const loadInitialData = async () => {
    setLoading(true);
    try {
      await Promise.all([loadCart(), loadSettings()]);
    } finally {
      setLoading(false);
    }
  };

  const loadSettings = async () => {
    try {
      const res = await api.get("/settings");
      const methods = Array.isArray(res?.data?.shippingMethods)
        ? res.data.shippingMethods.filter((m) => m?.active !== false)
        : [
            {
              id: "standard",
              name: "Standard Shipping",
              price: 150,
              deliveryDays: "5-7",
              active: true,
            },
            {
              id: "express",
              name: "Express Shipping",
              price: 350,
              deliveryDays: "2-3",
              active: true,
            },
          ];

      setShippingMethods(methods);

      if (methods.length > 0 && !deliveryInfo.method) {
        setDeliveryInfo((prev) => ({
          ...prev,
          method: safeStr(methods[0]?.id),
          cost: safeNum(methods[0]?.price, 0),
        }));
      }
    } catch (error) {
      console.error("Failed to load settings:", error);
      // Use default shipping methods
      setShippingMethods([
        {
          id: "standard",
          name: "Standard Shipping",
          price: 150,
          deliveryDays: "5-7",
        },
        {
          id: "express",
          name: "Express Shipping",
          price: 350,
          deliveryDays: "2-3",
        },
      ]);
    }
  };

  const loadCart = async () => {
    const cartData = await storage.get("cart");

    if (!cartData || !Array.isArray(cartData.items) || cartData.items.length === 0) {
      toast.error("Your cart is empty");
      navigate("/shop");
      return;
    }

    cartData.items = safeArr(cartData.items);
    setCart(cartData);

    try {
      const productPromises = cartData.items.map((item) =>
        api.get(`/products/${item.productId}`).catch(() => null)
      );

      const responses = await Promise.all(productPromises);
      const productsMap = {};

      responses.forEach((res) => {
        if (!res?.data) return;
        const p = res.data;
        if (p?.id) productsMap[p.id] = p;
        if (p?._id) productsMap[p._id] = p;
      });

      setProducts(productsMap);
    } catch (error) {
      console.error("Error loading products:", error);
      toast.error("Could not load products. Please refresh.");
    }
  };

  // ==================== FORM VALIDATION ====================

  const validateStep1 = () => {
    const newErrors = {};

    if (!safeStr(customerInfo.name)) newErrors.name = "Name is required";
    if (!safeStr(customerInfo.email)) {
      newErrors.email = "Email is required";
    } else if (!validateEmail(customerInfo.email)) {
      newErrors.email = "Please enter a valid email";
    }
    if (!safeStr(customerInfo.phone)) {
      newErrors.phone = "Phone is required";
    } else if (!validatePhone(customerInfo.phone)) {
      newErrors.phone = "Please enter a valid Kenyan phone number (e.g., 0712345678)";
    }

    if (!safeStr(deliveryInfo.address)) newErrors.address = "Address is required";
    if (!safeStr(deliveryInfo.city)) newErrors.city = "City is required";
    if (!safeStr(deliveryInfo.postalCode)) {
      newErrors.postalCode = "Postal code is required";
    } else if (!validatePostalCode(deliveryInfo.postalCode)) {
      newErrors.postalCode = "Please enter a valid postal code";
    }
    if (!safeStr(deliveryInfo.method)) newErrors.method = "Shipping method is required";

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const validatePayment = () => {
    if (paymentMethod === "mpesa" && !mpesaPhone) {
      toast.error("Please enter your M-Pesa phone number");
      return false;
    }
    if (paymentMethod === "mpesa" && !validatePhone(mpesaPhone)) {
      toast.error("Please enter a valid Kenyan phone number");
      return false;
    }
    return true;
  };

  // ==================== HANDLERS ====================

  const handleNextStep = () => {
    if (validateStep1()) {
      analytics.initiateCheckout(totals.total, safeArr(cart?.items).length || 0);
      setStep(2);
      window.scrollTo(0, 0);
    }
  };

  const handlePayment = async () => {
    if (!validatePayment()) return;

    setProcessingPayment(true);

    try {
      // Show loading toast
      const toastId = toast.loading("Processing payment...");

      // Create order data
      const orderNumber = buildOrderNumber();
      const nowIso = new Date().toISOString();

      const orderData = {
        orderNumber,
        customer: {
          name: safeStr(customerInfo.name),
          email: safeStr(customerInfo.email),
          phone: safeStr(customerInfo.phone),
        },
        delivery: {
          address: safeStr(deliveryInfo.address),
          city: safeStr(deliveryInfo.city),
          postalCode: safeStr(deliveryInfo.postalCode),
          method: safeStr(deliveryInfo.method),
          cost: safeNum(deliveryInfo.cost, 0),
        },
        items: safeArr(cart?.items),
        subtotal: totals.subtotal,
        giftWrapTotal: totals.giftWrapTotal,
        shippingCost: totals.shippingCost,
        tax: totals.tax,
        total: totals.total,
        payment: {
          method: "M-Pesa",
          status: "pending",
          phone: safeStr(mpesaPhone),
        },
        status: "pending_payment",
        statusHistory: [
          {
            status: "pending_payment",
            timestamp: nowIso,
            note: "Order created. Awaiting M-Pesa payment.",
          },
        ],
      };

      // Create order in backend
      const orderResponse = await api.post("/orders", orderData);
      const createdOrder = orderResponse.data;

      if (!createdOrder) {
        throw new Error("Failed to create order");
      }

      // Store order info locally
      try {
        await storage.set("lastOrder", {
          orderNumber: createdOrder?.orderNumber || orderNumber,
          phone: safeStr(customerInfo.phone),
          createdAt: nowIso,
        });
      } catch (e) {
        console.warn("Failed to store last order", e);
      }

      // Set order and proceed to payment monitoring
      setOrder(createdOrder);
      toast.dismiss(toastId);
      toast.success("Order created! Waiting for M-Pesa payment...");
      setStep(3);
      window.scrollTo(0, 0);

      // Track event
      analytics.addPaymentInfo(totals.total, "mpesa");
    } catch (error) {
      console.error("Payment processing error:", error);

      const errorMessage =
        error?.response?.data?.detail ||
        error?.response?.data?.message ||
        error?.message ||
        "Payment processing failed";

      toast.error(errorMessage);
    } finally {
      setProcessingPayment(false);
    }
  };

  const handleCheckStatusNow = async () => {
    if (!order?.orderNumber) return;

    try {
      setCheckingPaymentStatus(true);
      const res = await api.get(`/orders/track/${order.orderNumber}`);
      const latest = res?.data;

      if (!latest) {
        toast.error("Could not retrieve order status");
        return;
      }

      setOrder(latest);

      const paymentStatus = safeStr(latest?.payment?.status).toLowerCase();
      if (paymentStatus === "confirmed" || paymentStatus === "completed") {
        toast.success("Payment confirmed!");
        setTimeout(() => setStep(4), 300);
      } else if (paymentStatus === "failed") {
        toast.error("Payment failed. Please try again.");
      } else {
        toast.info("Payment is still pending. Check your phone for M-Pesa prompt.");
      }
    } catch (error) {
      console.error("Status check failed:", error);
      toast.error("Could not check payment status");
    } finally {
      setCheckingPaymentStatus(false);
    }
  };

  const handleCopyOrderNumber = async () => {
    const orderNo = safeStr(order?.orderNumber);
    if (!orderNo) return;

    try {
      await navigator.clipboard.writeText(orderNo);
      toast.success("Order number copied to clipboard");
    } catch (e) {
      try {
        const el = document.createElement("textarea");
        el.value = orderNo;
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
        toast.success("Order number copied");
      } catch {
        toast.error("Could not copy. Please select manually.");
      }
    }
  };

  const handleGoHome = () => {
    navigate("/");
  };

  const handleGoToTracking = () => {
    const orderNo = safeStr(order?.orderNumber);
    if (!orderNo) return;
    navigate(`/track-order?orderNumber=${encodeURIComponent(orderNo)}`);
  };

  // ==================== RENDER ====================

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f7f3ea] flex items-center justify-center">
        <Loader2 className="w-12 h-12 animate-spin text-black" />
      </div>
    );
  }

  const paymentStatus = safeStr(order?.payment?.status).toLowerCase();
  const orderStatus = safeStr(order?.status).toLowerCase();
  const isPaymentConfirmed =
    paymentStatus === "confirmed" ||
    paymentStatus === "completed" ||
    orderStatus === "processing" ||
    orderStatus === "confirmed";

  return (
    <div className="min-h-screen bg-[#f7f3ea]">
      {/* HEADER */}
      <div className="border-b border-[#e8e4dc] bg-white">
        <div className="container mx-auto px-6 md:px-12 py-8 max-w-7xl">
          <h1 className="font-serif text-4xl md:text-5xl text-black">Checkout</h1>
        </div>
      </div>

      <div className="container mx-auto px-6 md:px-12 py-12 max-w-7xl">
        {/* STEP INDICATOR */}
        <div className="mb-12">
          <div className="flex items-center justify-between">
            {[1, 2, 3, 4].map((s, idx) => (
              <div key={s} className="flex items-center flex-1">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center font-serif font-bold text-sm border-2 ${
                    s <= step
                      ? "bg-black text-white border-black"
                      : "bg-white text-black border-[#e8e4dc]"
                  }`}
                >
                  {s < step ? <Check size={20} /> : s}
                </div>
                {idx < 3 && (
                  <div
                    className={`flex-1 h-0.5 mx-2 ${
                      s < step ? "bg-black" : "bg-[#e8e4dc]"
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="flex justify-between text-xs text-neutral-500 mt-4">
            <span>Information</span>
            <span>Review</span>
            <span>Payment</span>
            <span>Confirmation</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
          {/* MAIN CONTENT */}
          <div className="lg:col-span-2 space-y-6">
            {/* STEP 1: CUSTOMER & DELIVERY INFO */}
            {step === 1 && (
              <div className="space-y-6">
                {/* CUSTOMER INFO */}
                <div className="bg-white border border-[#e8e4dc] p-8">
                  <h2 className="font-serif text-2xl text-black mb-6">Contact Information</h2>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">
                        Full Name *
                      </label>
                      <input
                        type="text"
                        placeholder="John Doe"
                        value={customerInfo.name}
                        onChange={(e) => {
                          setCustomerInfo({ ...customerInfo, name: e.target.value });
                          if (errors.name) setErrors({ ...errors, name: "" });
                        }}
                        className={`w-full px-4 py-3 border ${
                          errors.name ? "border-red-500" : "border-[#e8e4dc]"
                        } bg-[#fbfbfa] focus:outline-none focus:border-black transition`}
                      />
                      {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name}</p>}
                    </div>

                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">
                        Email Address *
                      </label>
                      <input
                        type="email"
                        placeholder="john@example.com"
                        value={customerInfo.email}
                        onChange={(e) => {
                          setCustomerInfo({ ...customerInfo, email: e.target.value });
                          if (errors.email) setErrors({ ...errors, email: "" });
                        }}
                        className={`w-full px-4 py-3 border ${
                          errors.email ? "border-red-500" : "border-[#e8e4dc]"
                        } bg-[#fbfbfa] focus:outline-none focus:border-black transition`}
                      />
                      {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email}</p>}
                    </div>

                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">
                        Phone Number * (Kenya)
                      </label>
                      <input
                        type="tel"
                        placeholder="0712345678 or +254712345678"
                        value={customerInfo.phone}
                        onChange={(e) => {
                          setCustomerInfo({ ...customerInfo, phone: e.target.value });
                          if (errors.phone) setErrors({ ...errors, phone: "" });
                        }}
                        className={`w-full px-4 py-3 border ${
                          errors.phone ? "border-red-500" : "border-[#e8e4dc]"
                        } bg-[#fbfbfa] focus:outline-none focus:border-black transition`}
                      />
                      {errors.phone && <p className="text-red-500 text-xs mt-1">{errors.phone}</p>}
                    </div>
                  </div>
                </div>

                {/* DELIVERY INFO */}
                <div className="bg-white border border-[#e8e4dc] p-8">
                  <h2 className="font-serif text-2xl text-black mb-6">Delivery Address</h2>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">
                        Street Address *
                      </label>
                      <input
                        type="text"
                        placeholder="123 Main Street"
                        value={deliveryInfo.address}
                        onChange={(e) => {
                          setDeliveryInfo({ ...deliveryInfo, address: e.target.value });
                          if (errors.address) setErrors({ ...errors, address: "" });
                        }}
                        className={`w-full px-4 py-3 border ${
                          errors.address ? "border-red-500" : "border-[#e8e4dc]"
                        } bg-[#fbfbfa] focus:outline-none focus:border-black transition`}
                      />
                      {errors.address && <p className="text-red-500 text-xs mt-1">{errors.address}</p>}
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">
                          City *
                        </label>
                        <input
                          type="text"
                          placeholder="Nairobi"
                          value={deliveryInfo.city}
                          onChange={(e) => {
                            setDeliveryInfo({ ...deliveryInfo, city: e.target.value });
                            if (errors.city) setErrors({ ...errors, city: "" });
                          }}
                          className={`w-full px-4 py-3 border ${
                            errors.city ? "border-red-500" : "border-[#e8e4dc]"
                          } bg-[#fbfbfa] focus:outline-none focus:border-black transition`}
                        />
                        {errors.city && <p className="text-red-500 text-xs mt-1">{errors.city}</p>}
                      </div>

                      <div>
                        <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">
                          Postal Code *
                        </label>
                        <input
                          type="text"
                          placeholder="00100"
                          value={deliveryInfo.postalCode}
                          onChange={(e) => {
                            setDeliveryInfo({ ...deliveryInfo, postalCode: e.target.value });
                            if (errors.postalCode) setErrors({ ...errors, postalCode: "" });
                          }}
                          className={`w-full px-4 py-3 border ${
                            errors.postalCode ? "border-red-500" : "border-[#e8e4dc]"
                          } bg-[#fbfbfa] focus:outline-none focus:border-black transition`}
                        />
                        {errors.postalCode && (
                          <p className="text-red-500 text-xs mt-1">{errors.postalCode}</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* SHIPPING METHOD */}
                <div className="bg-white border border-[#e8e4dc] p-8">
                  <h2 className="font-serif text-2xl text-black mb-6">Shipping Method</h2>
                  <div className="space-y-3">
                    {shippingMethods.map((method) => (
                      <label
                        key={method.id}
                        className="flex items-center p-4 border border-[#e8e4dc] cursor-pointer hover:bg-[#fbfbfa] transition"
                      >
                        <input
                          type="radio"
                          name="shipping"
                          value={method.id}
                          checked={deliveryInfo.method === method.id}
                          onChange={(e) => {
                            setDeliveryInfo({
                              ...deliveryInfo,
                              method: e.target.value,
                              cost: safeNum(method.price, 0),
                            });
                            if (errors.method) setErrors({ ...errors, method: "" });
                          }}
                          className="w-4 h-4"
                        />
                        <div className="flex-1 ml-4">
                          <p className="font-semibold text-black">{method.name}</p>
                          <p className="text-xs text-neutral-600">
                            {method.deliveryDays} business days
                          </p>
                        </div>
                        <p className="font-semibold text-black">KES {safeNum(method.price, 0)}</p>
                      </label>
                    ))}
                  </div>
                  {errors.method && <p className="text-red-500 text-xs mt-2">{errors.method}</p>}
                </div>

                {/* ACTION BUTTON */}
                <button
                  onClick={handleNextStep}
                  className="w-full bg-black text-white py-4 font-semibold hover:bg-neutral-900 transition flex items-center justify-center gap-2"
                >
                  Continue to Review <ChevronRight size={18} />
                </button>
              </div>
            )}

            {/* STEP 2: REVIEW */}
            {step === 2 && (
              <div className="space-y-6">
                {/* CUSTOMER INFO REVIEW */}
                <div className="bg-white border border-[#e8e4dc] p-8">
                  <div className="flex justify-between items-center mb-6">
                    <h2 className="font-serif text-2xl text-black">Order Summary</h2>
                    <button
                      onClick={() => setStep(1)}
                      className="text-sm text-neutral-600 hover:text-black underline"
                    >
                      Edit
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-6 mb-8 pb-8 border-b border-[#e8e4dc]">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">
                        Shipping To
                      </p>
                      <p className="font-semibold text-black">{customerInfo.name}</p>
                      <p className="text-sm text-neutral-600">{deliveryInfo.address}</p>
                      <p className="text-sm text-neutral-600">
                        {deliveryInfo.city} {deliveryInfo.postalCode}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-2">
                        Contact
                      </p>
                      <p className="text-sm text-neutral-600">{customerInfo.email}</p>
                      <p className="text-sm text-neutral-600">{customerInfo.phone}</p>
                    </div>
                  </div>

                  {/* SHIPPING METHOD */}
                  <div className="mb-6">
                    <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-3">
                      Shipping Method
                    </p>
                    <p className="font-semibold text-black">
                      {shippingMethods.find((m) => m.id === deliveryInfo.method)?.name}
                    </p>
                    <p className="text-sm text-neutral-600">
                      Cost: KES {deliveryInfo.cost}
                    </p>
                  </div>
                </div>

                {/* ORDER ITEMS */}
                <div className="bg-white border border-[#e8e4dc] p-8">
                  <h3 className="font-serif text-xl text-black mb-6">Items</h3>
                  <div className="space-y-4">
                    {safeArr(cart?.items).map((item, idx) => {
                      const product = products[item.productId];
                      if (!product) return null;

                      const img = pickDefaultImage(product);
                      const price = safeNum(product.salePrice || product.price || product.basePrice || 0);
                      const itemTotal = price * safeNum(item.quantity, 1);

                      return (
                        <div key={idx} className="flex gap-4 pb-4 border-b border-[#e8e4dc] last:border-b-0">
                          <img
                            src={absolutizeMaybe(img)}
                            alt={product.name}
                            className="w-20 h-20 object-cover bg-[#fbfbfa]"
                          />
                          <div className="flex-1">
                            <p className="font-semibold text-black">{product.name}</p>
                            <p className="text-sm text-neutral-600">
                              Qty: {item.quantity}
                              {item.variant?.size && ` • Size: ${item.variant.size}`}
                              {item.variant?.color && ` • Color: ${item.variant.color}`}
                            </p>
                            {item.giftWrap && (
                              <p className="text-xs text-neutral-500">✨ Gift wrap included</p>
                            )}
                          </div>
                          <div className="text-right">
                            <p className="font-semibold text-black">KES {itemTotal}</p>
                            <p className="text-xs text-neutral-600">{price} each</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* ACTION BUTTONS */}
                <div className="flex gap-4">
                  <button
                    onClick={() => setStep(1)}
                    className="flex-1 border-2 border-black text-black py-4 font-semibold hover:bg-black hover:text-white transition"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => setStep(3)}
                    className="flex-1 bg-black text-white py-4 font-semibold hover:bg-neutral-900 transition flex items-center justify-center gap-2"
                  >
                    Go to Payment <ChevronRight size={18} />
                  </button>
                </div>
              </div>
            )}

            {/* STEP 3: PAYMENT */}
            {step === 3 && (
              <div className="space-y-6">
                {/* PAYMENT METHOD */}
                <div className="bg-white border border-[#e8e4dc] p-8">
                  <h2 className="font-serif text-2xl text-black mb-6">Payment Method</h2>

                  {/* M-PESA OPTION */}
                  <div className="border border-[#e8e4dc] p-6 mb-6">
                    <label className="flex items-start cursor-pointer">
                      <input
                        type="radio"
                        name="payment"
                        value="mpesa"
                        checked={paymentMethod === "mpesa"}
                        onChange={(e) => setPaymentMethod(e.target.value)}
                        className="w-5 h-5 mt-1"
                      />
                      <div className="ml-4 flex-1">
                        <p className="font-semibold text-black mb-2">M-Pesa (MPESA)</p>
                        <p className="text-sm text-neutral-600 mb-4">
                          Pay securely using your M-Pesa account. You'll receive a prompt on your phone.
                        </p>

                        {paymentMethod === "mpesa" && (
                          <input
                            type="tel"
                            placeholder="0712345678 or +254712345678"
                            value={mpesaPhone}
                            onChange={(e) => setMpesaPhone(e.target.value)}
                            className="w-full px-4 py-2 border border-[#e8e4dc] bg-[#fbfbfa] focus:outline-none focus:border-black transition text-sm"
                          />
                        )}
                      </div>
                    </label>
                  </div>
                </div>

                {/* ORDER TOTAL */}
                <div className="bg-white border border-[#e8e4dc] p-8">
                  <h3 className="font-serif text-xl text-black mb-6">Order Total</h3>
                  <div className="space-y-3 pb-6 border-b border-[#e8e4dc]">
                    <div className="flex justify-between">
                      <span>Subtotal</span>
                      <span>KES {totals.subtotal}</span>
                    </div>
                    {totals.giftWrapTotal > 0 && (
                      <div className="flex justify-between">
                        <span>Gift Wrap</span>
                        <span>KES {totals.giftWrapTotal}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span>Shipping</span>
                      <span>KES {totals.shippingCost}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Tax (16% VAT)</span>
                      <span>KES {totals.tax}</span>
                    </div>
                  </div>
                  <div className="flex justify-between pt-6">
                    <span className="font-serif text-xl">Total</span>
                    <span className="font-serif text-2xl font-bold">KES {totals.total}</span>
                  </div>
                </div>

                {/* ACTION BUTTONS */}
                <div className="flex gap-4">
                  <button
                    onClick={() => setStep(2)}
                    disabled={processingPayment}
                    className="flex-1 border-2 border-black text-black py-4 font-semibold hover:bg-black hover:text-white transition disabled:opacity-50"
                  >
                    Back
                  </button>
                  <button
                    onClick={handlePayment}
                    disabled={processingPayment}
                    className="flex-1 bg-black text-white py-4 font-semibold hover:bg-neutral-900 transition disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {processingPayment ? (
                      <>
                        <Loader2 size={18} className="animate-spin" />
                        Processing...
                      </>
                    ) : (
                      <>
                        Pay KES {totals.total} <ChevronRight size={18} />
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* STEP 4: CONFIRMATION */}
            {step === 4 && (
              <div className="text-center">
                <div className="bg-green-50 border border-green-200 p-12 mb-8">
                  <div className="text-6xl mb-6">✨</div>
                  <h2 className="font-serif text-3xl text-black mb-3">Order Confirmed!</h2>
                  <p className="text-neutral-600 mb-6">
                    Your order has been placed successfully. You'll receive a confirmation email shortly.
                  </p>

                  <div className="bg-white border border-[#e8e4dc] p-8 mb-8 text-left">
                    <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-3">
                      Order Number
                    </p>
                    <div className="flex items-center gap-3">
                      <p className="font-serif text-2xl font-bold text-black">
                        {order?.orderNumber}
                      </p>
                      <button
                        onClick={handleCopyOrderNumber}
                        className="p-2 hover:bg-[#fbfbfa] transition"
                        title="Copy order number"
                      >
                        <CopyIcon size={18} />
                      </button>
                    </div>

                    <div className="mt-8 pt-8 border-t border-[#e8e4dc]">
                      <p className="text-xs font-semibold uppercase tracking-wider text-neutral-600 mb-3">
                        What's Next?
                      </p>
                      <ul className="text-sm text-neutral-600 space-y-2">
                        <li>✓ You'll receive an order confirmation email at {customerInfo.email}</li>
                        <li>✓ Your order will be processed within 1-2 business days</li>
                        <li>✓ You can track your order anytime using your order number</li>
                      </ul>
                    </div>
                  </div>
                </div>

                {/* ACTION BUTTONS */}
                <div className="flex gap-4">
                  <button
                    onClick={handleGoToTracking}
                    className="flex-1 border-2 border-black text-black py-4 font-semibold hover:bg-black hover:text-white transition"
                  >
                    Track Order
                  </button>
                  <button
                    onClick={handleGoHome}
                    className="flex-1 bg-black text-white py-4 font-semibold hover:bg-neutral-900 transition"
                  >
                    Continue Shopping
                  </button>
                </div>
              </div>
            )}

            {/* PAYMENT PENDING STATE */}
            {step === 3 && order && !isPaymentConfirmed && (
              <div className="fixed inset-0 bg-black/20 flex items-center justify-center p-4 z-50">
                <div className="bg-white p-8 max-w-md">
                  <div className="text-4xl mb-4">📱</div>
                  <h3 className="font-serif text-xl text-black mb-3">Awaiting M-Pesa Payment</h3>
                  <p className="text-neutral-600 mb-6">
                    Check your phone for an M-Pesa prompt. Enter your M-Pesa PIN to complete the payment.
                  </p>
                  <p className="text-sm text-neutral-500 mb-6">
                    Amount: <span className="font-bold text-black">KES {totals.total}</span>
                  </p>

                  <button
                    onClick={handleCheckStatusNow}
                    disabled={checkingPaymentStatus}
                    className="w-full bg-black text-white py-3 font-semibold hover:bg-neutral-900 transition disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {checkingPaymentStatus ? (
                      <>
                        <Loader2 size={18} className="animate-spin" />
                        Checking...
                      </>
                    ) : (
                      "Check Payment Status"
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* SIDEBAR: CART SUMMARY */}
          <div className="space-y-6">
            {/* CART ITEMS */}
            <div className="bg-white border border-[#e8e4dc] p-8 sticky top-8">
              <h3 className="font-serif text-xl text-black mb-6">Order</h3>
              <div className="space-y-4 mb-6 pb-6 border-b border-[#e8e4dc]">
                {safeArr(cart?.items).map((item, idx) => {
                  const product = products[item.productId];
                  if (!product) return null;

                  const price = safeNum(product.salePrice || product.price || product.basePrice || 0);

                  return (
                    <div key={idx} className="flex justify-between text-sm">
                      <span className="text-neutral-600">
                        {product.name} x{item.quantity}
                      </span>
                      <span className="font-semibold text-black">
                        KES {price * safeNum(item.quantity, 1)}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* TOTALS */}
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span>Subtotal</span>
                  <span>KES {totals.subtotal}</span>
                </div>
                {totals.giftWrapTotal > 0 && (
                  <div className="flex justify-between text-sm">
                    <span>Gift Wrap</span>
                    <span>KES {totals.giftWrapTotal}</span>
                  </div>
                )}
                {step > 1 && (
                  <>
                    <div className="flex justify-between text-sm">
                      <span>Shipping</span>
                      <span>KES {totals.shippingCost}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span>Tax</span>
                      <span>KES {totals.tax}</span>
                    </div>
                  </>
                )}
                <div className="flex justify-between pt-3 border-t border-[#e8e4dc] font-serif text-lg">
                  <span>Total</span>
                  <span className="font-bold">KES {totals.total}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}