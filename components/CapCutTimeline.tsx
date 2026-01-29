import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer } from 'expo-video';
import * as VideoThumbnails from 'expo-video-thumbnails';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Dimensions,
    PixelRatio,
    Platform,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    interpolate,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const PIXEL_RATIO = PixelRatio.get();
const IS_LOW_END_DEVICE = PIXEL_RATIO < 2 || Platform.OS === 'android';

const TIMELINE_PADDING = 20;
const TIMELINE_WIDTH = SCREEN_WIDTH - TIMELINE_PADDING * 2;
const TIMELINE_HEIGHT = 56;
const PLAYHEAD_WIDTH = 4;
const THUMBNAIL_HEIGHT = 48;

// Adaptive thumbnail count based on device capability
const THUMBNAIL_COUNT = IS_LOW_END_DEVICE ? 6 : 10;
const THUMBNAIL_WIDTH = (TIMELINE_WIDTH - PLAYHEAD_WIDTH) / THUMBNAIL_COUNT;

// Thumbnail generation settings - optimized for device
const THUMBNAIL_CONFIG = {
    quality: IS_LOW_END_DEVICE ? 0.2 : 0.3,
    // Request exact pixel dimensions to avoid scaling overhead
    width: Math.round(THUMBNAIL_WIDTH * PIXEL_RATIO),
    height: Math.round(THUMBNAIL_HEIGHT * PIXEL_RATIO),
};

// Limit concurrent thumbnail generation to prevent memory pressure
const MAX_CONCURRENT_THUMBNAILS = IS_LOW_END_DEVICE ? 2 : 4;

// ============================================================================
// THUMBNAIL CACHE (Singleton)
// ============================================================================

class ThumbnailCache {
    private static instance: ThumbnailCache;
    private cache = new Map<string, string[]>();
    private maxSize = 5; // Keep max 5 videos in cache

    static getInstance(): ThumbnailCache {
        if (!ThumbnailCache.instance) {
            ThumbnailCache.instance = new ThumbnailCache();
        }
        return ThumbnailCache.instance;
    }

    get(key: string): string[] | undefined {
        return this.cache.get(key);
    }

    set(key: string, thumbnails: string[]): void {
        // LRU eviction
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) this.cache.delete(firstKey);
        }
        this.cache.set(key, thumbnails);
    }

    clear(): void {
        this.cache.clear();
    }
}

// ============================================================================
// UTILITIES
// ============================================================================

const formatTime = (seconds: number): string => {
    if (!seconds || isNaN(seconds)) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const formatTimeMs = (seconds: number): string => {
    if (!seconds || isNaN(seconds)) return '00:00.00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
};

// Chunked parallel execution to limit concurrency
async function generateThumbnailsWithLimit<T>(
    tasks: (() => Promise<T>)[],
    limit: number
): Promise<T[]> {
    const results: T[] = [];
    const executing: Promise<void>[] = [];

    for (const task of tasks) {
        const p = task().then((result) => {
            results.push(result);
            executing.splice(executing.indexOf(p), 1);
        });
        executing.push(p);

        if (executing.length >= limit) {
            await Promise.race(executing);
        }
    }

    await Promise.all(executing);
    return results;
}

// ============================================================================
// THUMBNAIL FRAME COMPONENT
// ============================================================================

interface ThumbnailFrameProps {
    index: number;
    thumbnailUri: string | null;
    isLoading: boolean;
}

const ThumbnailFrame = memo(
    function ThumbnailFrame({ index, thumbnailUri, isLoading }: ThumbnailFrameProps) {
        const hue = (index * 360) / THUMBNAIL_COUNT;

        return (
            <View style={[styles.thumbnailFrame, { width: THUMBNAIL_WIDTH }]}>
                {thumbnailUri ? (
                    <Image
                        source={{ uri: thumbnailUri }}
                        style={styles.thumbnailImage}
                        contentFit="cover"
                        transition={150}
                        cachePolicy="memory-disk"
                        recyclingKey={`thumb-${index}`}
                    />
                ) : (
                    <LinearGradient
                        colors={[`hsla(${hue}, 40%, 20%, 1)`, `hsla(${hue + 15}, 40%, 15%, 1)`]}
                        style={styles.thumbnailGradient}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                    />
                )}
                {isLoading && (
                    <View style={styles.loadingOverlay}>
                        <ActivityIndicator size="small" color="rgba(255,255,255,0.7)" />
                    </View>
                )}
            </View>
        );
    },
    (prev, next) =>
        prev.thumbnailUri === next.thumbnailUri &&
        prev.isLoading === next.isLoading &&
        prev.index === next.index
);

// ============================================================================
// THUMBNAIL STRIP COMPONENT
// ============================================================================

interface ThumbnailStripProps {
    thumbnails: (string | null)[];
    isLoading: boolean;
}

const ThumbnailStrip = memo(
    function ThumbnailStrip({ thumbnails, isLoading }: ThumbnailStripProps) {
        return (
            <View style={styles.thumbnailStrip}>
                {thumbnails.map((uri, i) => (
                    <ThumbnailFrame
                        key={i}
                        index={i}
                        thumbnailUri={uri}
                        isLoading={isLoading && !uri}
                    />
                ))}
            </View>
        );
    },
    (prev, next) =>
        prev.isLoading === next.isLoading &&
        prev.thumbnails.length === next.thumbnails.length &&
        prev.thumbnails.every((t, i) => t === next.thumbnails[i])
);

// ============================================================================
// MAIN TIMELINE COMPONENT
// ============================================================================

interface CapCutTimelineProps {
    player: ReturnType<typeof useVideoPlayer>;
    videoUri: string;
}

export const CapCutTimeline = memo(function CapCutTimeline({
    player,
    videoUri,
}: CapCutTimelineProps) {
    // State
    const [duration, setDuration] = useState(0);
    const [displayTime, setDisplayTime] = useState(0);
    const [thumbnails, setThumbnails] = useState<(string | null)[]>(() =>
        Array(THUMBNAIL_COUNT).fill(null)
    );
    const [isLoadingThumbnails, setIsLoadingThumbnails] = useState(true);

    // Refs
    const isMountedRef = useRef(true);
    const abortControllerRef = useRef<AbortController | null>(null);
    const cache = useMemo(() => ThumbnailCache.getInstance(), []);

    // Animated values
    const isDragging = useSharedValue(false);
    const progress = useSharedValue(0);
    const playheadScale = useSharedValue(1);

    // Cleanup on unmount
    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            abortControllerRef.current?.abort();
        };
    }, []);

    // Generate thumbnails with optimized parallel loading
    useEffect(() => {
        if (duration <= 0 || !videoUri) return;

        // Abort any previous generation
        abortControllerRef.current?.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;

        const cacheKey = `${videoUri}_${Math.round(duration)}`;

        // Check cache first
        const cached = cache.get(cacheKey);
        if (cached && cached.length === THUMBNAIL_COUNT) {
            setThumbnails(cached);
            setIsLoadingThumbnails(false);
            return;
        }

        const generate = async () => {
            if (!isMountedRef.current) return;
            setIsLoadingThumbnails(true);

            const tasks = Array.from({ length: THUMBNAIL_COUNT }, (_, i) => async () => {
                if (controller.signal.aborted) return null;

                const timeMs = (duration / THUMBNAIL_COUNT) * i * 1000;
                try {
                    const result = await VideoThumbnails.getThumbnailAsync(videoUri, {
                        time: timeMs,
                        quality: THUMBNAIL_CONFIG.quality,
                    });
                    return result.uri;
                } catch {
                    // Silent fail for individual thumbnails
                    return null;
                }
            });

            try {
                const results = await generateThumbnailsWithLimit(
                    tasks,
                    MAX_CONCURRENT_THUMBNAILS
                );

                if (!controller.signal.aborted && isMountedRef.current) {
                    // Sort results back to original order
                    const orderedResults = Array(THUMBNAIL_COUNT).fill(null);
                    results.forEach((uri, idx) => {
                        if (uri) orderedResults[idx] = uri;
                    });

                    setThumbnails(orderedResults);
                    setIsLoadingThumbnails(false);

                    // Cache valid results
                    if (orderedResults.some((r) => r !== null)) {
                        cache.set(cacheKey, orderedResults);
                    }
                }
            } catch {
                if (isMountedRef.current) {
                    setIsLoadingThumbnails(false);
                }
            }
        };

        generate();

        return () => controller.abort();
    }, [duration, videoUri, cache]);

    // Callbacks
    const seekTo = useCallback(
        (time: number) => {
            player.currentTime = time;
        },
        [player]
    );

    const updateDisplayTime = useCallback((time: number) => {
        setDisplayTime(time);
    }, []);

    // Subscribe to time updates
    useEffect(() => {
        const subscription = player.addListener('timeUpdate', (payload) => {
            if (!isDragging.value && duration > 0) {
                progress.value = payload.currentTime / duration;
                scheduleOnRN(updateDisplayTime, payload.currentTime);
            }
        });
        return () => subscription.remove();
    }, [player, duration, isDragging, progress, updateDisplayTime]);

    // Subscribe to status changes (for duration)
    useEffect(() => {
        const subscription = player.addListener('statusChange', () => {
            if (player.duration > 0) {
                setDuration(player.duration);
            }
        });
        if (player.duration > 0) {
            setDuration(player.duration);
        }
        return () => subscription.remove();
    }, [player]);

    // Gestures
    const tapGesture = Gesture.Tap()
        .onStart(() => {
            'worklet';
            playheadScale.value = withSpring(1.4, { damping: 12, stiffness: 180 });
        })
        .onEnd((event) => {
            'worklet';
            const x = Math.max(0, Math.min(event.x, TIMELINE_WIDTH));
            const newProgress = x / TIMELINE_WIDTH;
            progress.value = newProgress;
            const newTime = newProgress * duration;
            scheduleOnRN(seekTo, newTime);
            scheduleOnRN(updateDisplayTime, newTime);
            playheadScale.value = withSpring(1, { damping: 12, stiffness: 180 });
        });

    const panGesture = Gesture.Pan()
        .onStart(() => {
            'worklet';
            isDragging.value = true;
            playheadScale.value = withSpring(1.25, { damping: 12, stiffness: 180 });
        })
        .onUpdate((event) => {
            'worklet';
            const x = Math.max(0, Math.min(event.x, TIMELINE_WIDTH));
            const newProgress = x / TIMELINE_WIDTH;
            progress.value = newProgress;
            const newTime = newProgress * duration;
            scheduleOnRN(updateDisplayTime, newTime);
        })
        .onEnd((event) => {
            'worklet';
            const x = Math.max(0, Math.min(event.x, TIMELINE_WIDTH));
            const newProgress = x / TIMELINE_WIDTH;
            const newTime = newProgress * duration;
            scheduleOnRN(seekTo, newTime);
            isDragging.value = false;
            playheadScale.value = withSpring(1, { damping: 12, stiffness: 180 });
        });

    const composedGesture = Gesture.Race(tapGesture, panGesture);

    // Animated styles
    const playheadStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: progress.value * (TIMELINE_WIDTH - PLAYHEAD_WIDTH) },
            { scaleY: playheadScale.value },
        ],
    }));

    const timeIndicatorStyle = useAnimatedStyle(() => {
        const opacity = interpolate(playheadScale.value, [1, 1.25], [0, 1]);
        return {
            opacity,
            transform: [
                { translateX: progress.value * (TIMELINE_WIDTH - PLAYHEAD_WIDTH) - 30 },
                { translateY: interpolate(playheadScale.value, [1, 1.25], [8, 0]) },
            ],
        };
    });

    const progressOverlayStyle = useAnimatedStyle(() => ({
        width: progress.value * TIMELINE_WIDTH,
    }));

    // Memoized time markers
    const timeMarkers = useMemo(() => {
        return Array.from({ length: 5 }, (_, i) => formatTime((duration / 4) * i));
    }, [duration]);

    return (
        <View style={styles.container}>
            {/* Time display */}
            <View style={styles.timeRow}>
                <Text style={styles.currentTime}>{formatTimeMs(displayTime)}</Text>
                <Text style={styles.duration}>{formatTime(duration)}</Text>
            </View>

            {/* Timeline */}
            <GestureDetector gesture={composedGesture}>
                <View style={styles.timelineContainer}>
                    <ThumbnailStrip thumbnails={thumbnails} isLoading={isLoadingThumbnails} />

                    <Animated.View style={[styles.progressOverlay, progressOverlayStyle]} />

                    <Animated.View style={[styles.playhead, playheadStyle]}>
                        <View style={styles.playheadLine} />
                        <View style={styles.playheadHandle} />
                        <View style={styles.playheadHandleBottom} />
                    </Animated.View>

                    <Animated.View style={[styles.floatingTimeIndicator, timeIndicatorStyle]}>
                        <Text style={styles.floatingTimeText}>{formatTimeMs(displayTime)}</Text>
                    </Animated.View>
                </View>
            </GestureDetector>

            {/* Time markers */}
            <View style={styles.markersRow}>
                {timeMarkers.map((time, i) => (
                    <Text key={i} style={styles.markerText}>
                        {time}
                    </Text>
                ))}
            </View>
        </View>
    );
});

// ============================================================================
// STYLES
// ============================================================================

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: TIMELINE_PADDING,
        marginTop: 24,
    },
    timeRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
    },
    currentTime: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '600',
        fontVariant: ['tabular-nums'],
    },
    duration: {
        color: '#666',
        fontSize: 14,
        fontVariant: ['tabular-nums'],
    },
    timelineContainer: {
        height: TIMELINE_HEIGHT,
        backgroundColor: '#1a1a1a',
        borderRadius: 8,
        overflow: 'hidden',
        position: 'relative',
    },
    thumbnailStrip: {
        flexDirection: 'row',
        height: THUMBNAIL_HEIGHT,
        marginTop: (TIMELINE_HEIGHT - THUMBNAIL_HEIGHT) / 2,
    },
    thumbnailFrame: {
        height: THUMBNAIL_HEIGHT,
        overflow: 'hidden',
    },
    thumbnailImage: {
        width: '100%',
        height: '100%',
    },
    thumbnailGradient: {
        flex: 1,
    },
    loadingOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.2)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    progressOverlay: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        backgroundColor: 'rgba(59, 130, 246, 0.2)',
    },
    playhead: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: PLAYHEAD_WIDTH,
        alignItems: 'center',
    },
    playheadLine: {
        flex: 1,
        width: 2,
        backgroundColor: '#fff',
        shadowColor: '#fff',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.5,
        shadowRadius: 4,
    },
    playheadHandle: {
        position: 'absolute',
        top: -6,
        width: 14,
        height: 14,
        borderRadius: 3,
        backgroundColor: '#fff',
        transform: [{ rotate: '45deg' }],
    },
    playheadHandleBottom: {
        position: 'absolute',
        bottom: -6,
        width: 14,
        height: 14,
        borderRadius: 3,
        backgroundColor: '#fff',
        transform: [{ rotate: '45deg' }],
    },
    floatingTimeIndicator: {
        position: 'absolute',
        top: -35,
        width: 70,
        height: 28,
        backgroundColor: '#3b82f6',
        borderRadius: 6,
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
        elevation: 5,
    },
    floatingTimeText: {
        color: '#fff',
        fontSize: 12,
        fontWeight: '600',
        fontVariant: ['tabular-nums'],
    },
    markersRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 8,
    },
    markerText: {
        color: '#444',
        fontSize: 10,
        fontVariant: ['tabular-nums'],
    },
});

export default CapCutTimeline;
