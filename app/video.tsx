import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { memo, useCallback, useState } from 'react';
import { Dimensions, StyleSheet, TouchableOpacity, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CapCutTimeline } from '../components/CapCutTimeline';

// 4K Video with Audio - Sintel (Blender Foundation)
const videoSource =
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4';
const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Stable screen options
const screenOptions = {
    title: 'Expo Video Demo',
    headerTintColor: '#fff',
    headerStyle: { backgroundColor: '#000' },
};

// Controls Component
interface VideoControlsProps {
    player: ReturnType<typeof useVideoPlayer>;
}

const VideoControls = memo(function VideoControls({ player }: VideoControlsProps) {
    const [isPlaying, setIsPlaying] = useState(false);

    React.useEffect(() => {
        const subscription = player.addListener('playingChange', (payload) => {
            setIsPlaying(payload.isPlaying);
        });
        setIsPlaying(player.playing);
        return () => subscription.remove();
    }, [player]);

    const togglePlayback = useCallback(() => {
        if (player.playing) {
            player.pause();
        } else {
            player.play();
        }
    }, [player]);

    const seekBackward = useCallback(() => {
        player.currentTime = Math.max(0, player.currentTime - 10);
    }, [player]);

    const seekForward = useCallback(() => {
        player.currentTime = Math.min(player.duration || 0, player.currentTime + 10);
    }, [player]);

    return (
        <View style={styles.actionsContainer}>
            <TouchableOpacity style={styles.iconButton} onPress={seekBackward}>
                <Ionicons name="play-back" size={24} color="white" />
            </TouchableOpacity>

            <TouchableOpacity style={[styles.iconButton, styles.playButton]} onPress={togglePlayback}>
                <Ionicons name={isPlaying ? 'pause' : 'play'} size={32} color="black" />
            </TouchableOpacity>

            <TouchableOpacity style={styles.iconButton} onPress={seekForward}>
                <Ionicons name="play-forward" size={24} color="white" />
            </TouchableOpacity>
        </View>
    );
});

export default function VideoScreen() {
    const setupPlayer = useCallback((p: ReturnType<typeof useVideoPlayer>) => {
        p.loop = true;
        p.timeUpdateEventInterval = 0.1; // 100ms for smooth timeline
        p.play();
    }, []);

    const player = useVideoPlayer(videoSource, setupPlayer);

    return (
        <GestureHandlerRootView style={styles.container}>
            <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
                <Stack.Screen options={screenOptions} />

                <View style={styles.videoContainer}>
                    <VideoView
                        style={styles.video}
                        player={player}
                        fullscreenOptions={{ enable: true }}
                        allowsPictureInPicture
                        nativeControls={false}
                    />
                </View>

                {/* CapCut-style Timeline */}
                <CapCutTimeline player={player} videoUri={videoSource} />

                {/* Playback Controls */}
                <VideoControls player={player} />
            </SafeAreaView>
        </GestureHandlerRootView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#000',
    },
    videoContainer: {
        width: SCREEN_WIDTH,
        height: SCREEN_WIDTH * (9 / 16),
        backgroundColor: '#111',
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: 20,
    },
    video: {
        width: '100%',
        height: '100%',
    },
    actionsContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 30,
        marginTop: 30,
    },
    iconButton: {
        padding: 10,
        borderRadius: 25,
        backgroundColor: 'rgba(255,255,255,0.1)',
    },
    playButton: {
        backgroundColor: '#fff',
        padding: 15,
        borderRadius: 35,
    },
});
