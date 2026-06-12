/**
 * MpesaPayment.jsx — React Native Integration Example
 *
 * Usage:
 *   <MpesaPayment amount={100} orderId="ORDER123" onSuccess={handleSuccess} />
 *
 * Dependencies:
 *   npm install axios @react-native-async-storage/async-storage
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE_URL = 'https://your-api-domain.com'; // ← change this

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT token to every request
api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('jwt_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ── Custom hook ───────────────────────────────────────────────────────────────
const useMpesaPayment = ({ onSuccess, onFailure } = {}) => {
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [status, setStatus] = useState(null); // PENDING | SUCCESS | FAILED | CANCELLED | TIMEOUT
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState(null);

  const pollStatus = useCallback(
    async (checkoutRequestId, attempts = 0) => {
      if (attempts >= 10) {
        setStatus('TIMEOUT');
        setPolling(false);
        return;
      }

      try {
        const { data } = await api.get(`/api/payments/${checkoutRequestId}`);

        if (data.data.status === 'PENDING') {
          setTimeout(() => pollStatus(checkoutRequestId, attempts + 1), 3000);
          return;
        }

        setStatus(data.data.status);
        setPolling(false);

        if (data.data.status === 'SUCCESS') {
          setReceipt(data.data.receipt);
          onSuccess?.({ receipt: data.data.receipt, amount: data.data.amount });
        } else {
          onFailure?.({ status: data.data.status, message: data.data.resultDesc });
        }
      } catch (err) {
        // Network blip — keep polling
        setTimeout(() => pollStatus(checkoutRequestId, attempts + 1), 3000);
      }
    },
    [onSuccess, onFailure]
  );

  const initiatePayment = useCallback(
    async ({ phone, amount, accountReference, transactionDesc }) => {
      setLoading(true);
      setError(null);
      setStatus(null);
      setReceipt(null);

      try {
        const { data } = await api.post('/api/payments/stkpush', {
          phone,
          amount,
          accountReference,
          transactionDesc: transactionDesc || 'Payment',
        });

        if (data.success) {
          setStatus('PENDING');
          setPolling(true);
          // Start polling after a 5 s head-start (give user time to enter PIN)
          setTimeout(() => pollStatus(data.data.checkoutRequestId), 5000);
          return data.data;
        }
      } catch (err) {
        const msg = err.response?.data?.message || 'Payment initiation failed';
        setError(msg);
        onFailure?.({ message: msg });
      } finally {
        setLoading(false);
      }
    },
    [pollStatus, onFailure]
  );

  return { initiatePayment, loading, polling, status, receipt, error };
};

// ── Component ─────────────────────────────────────────────────────────────────
const MpesaPayment = ({ amount = 0, orderId = '', onSuccess, onFailure }) => {
  const [phone, setPhone] = useState('');

  const { initiatePayment, loading, polling, status, receipt, error } = useMpesaPayment({
    onSuccess,
    onFailure,
  });

  const handlePay = async () => {
    if (!phone.trim()) {
      Alert.alert('Error', 'Please enter your M-Pesa phone number');
      return;
    }

    await initiatePayment({
      phone: phone.trim(),
      amount,
      accountReference: orderId,
      transactionDesc: `Order ${orderId}`,
    });
  };

  // ── Status UI ───────────────────────────────────────────────────────────
  if (polling || status === 'PENDING') {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#4CAF50" />
        <Text style={styles.pollingText}>Waiting for M-Pesa confirmation…</Text>
        <Text style={styles.subText}>Please enter your M-Pesa PIN on your phone</Text>
      </View>
    );
  }

  if (status === 'SUCCESS') {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.successIcon}>✅</Text>
        <Text style={styles.successText}>Payment Successful!</Text>
        <Text style={styles.receiptText}>Receipt: {receipt}</Text>
        <Text style={styles.amountText}>KES {amount.toLocaleString()}</Text>
      </View>
    );
  }

  if (status === 'FAILED' || status === 'CANCELLED') {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.failIcon}>❌</Text>
        <Text style={styles.failText}>
          {status === 'CANCELLED' ? 'Payment Cancelled' : 'Payment Failed'}
        </Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => setPhone('')}>
          <Text style={styles.retryText}>Try Again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Payment form ────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Pay with M-Pesa</Text>
      <Text style={styles.amountLabel}>KES {amount.toLocaleString()}</Text>

      <Text style={styles.label}>M-Pesa Phone Number</Text>
      <TextInput
        style={styles.input}
        placeholder="07XXXXXXXX or 2547XXXXXXXX"
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        maxLength={15}
        editable={!loading}
      />

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <TouchableOpacity
        style={[styles.payButton, loading && styles.payButtonDisabled]}
        onPress={handlePay}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.payButtonText}>Pay KES {amount.toLocaleString()}</Text>
        )}
      </TouchableOpacity>

      <Text style={styles.disclaimer}>
        You will receive an M-Pesa prompt on your phone. Enter your PIN to confirm.
      </Text>
    </View>
  );
};

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { padding: 20 },
  centerContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 4, color: '#1a1a1a' },
  amountLabel: { fontSize: 28, fontWeight: '800', color: '#4CAF50', marginBottom: 24 },
  label: { fontSize: 14, color: '#555', marginBottom: 6 },
  input: {
    borderWidth: 1, borderColor: '#ddd', borderRadius: 8,
    padding: 12, fontSize: 16, marginBottom: 16, color: '#1a1a1a',
  },
  payButton: {
    backgroundColor: '#4CAF50', borderRadius: 10,
    padding: 16, alignItems: 'center', marginTop: 8,
  },
  payButtonDisabled: { backgroundColor: '#a5d6a7' },
  payButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  errorText: { color: '#e53935', fontSize: 13, marginBottom: 10 },
  disclaimer: { fontSize: 12, color: '#888', textAlign: 'center', marginTop: 16 },
  pollingText: { fontSize: 18, fontWeight: '600', marginTop: 16 },
  subText: { fontSize: 14, color: '#888', marginTop: 8, textAlign: 'center' },
  successIcon: { fontSize: 60 },
  successText: { fontSize: 22, fontWeight: '700', color: '#4CAF50', marginTop: 12 },
  receiptText: { fontSize: 16, color: '#555', marginTop: 8 },
  amountText: { fontSize: 18, fontWeight: '600', marginTop: 4 },
  failIcon: { fontSize: 60 },
  failText: { fontSize: 20, fontWeight: '600', color: '#e53935', marginTop: 12 },
  retryButton: {
    marginTop: 20, backgroundColor: '#1976D2',
    borderRadius: 8, paddingHorizontal: 32, paddingVertical: 12,
  },
  retryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});

export default MpesaPayment;
export { useMpesaPayment };
